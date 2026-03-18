/**
 * imgProcessor.js
 * 负责处理缺失背面的包装盒图片，生成拟真的通用实体背板
 * * 修改记录：
 * 1. [Fix] 彻底抛弃遍历修改像素透明度的做法，改为“计算边界并裁剪覆盖”，根治了误杀封面真实绿色图案的 Bug。
 * 2. [Feat] 边界扫描算法终极重构：跳过左侧10%边缘杂色，加入10像素前向探路防抖，精准切除背景。
 * 3. [Feat] 完美兼容：同时支持识别 绿幕、纯黑幕 以及 透明幕。
 * 4. [UI] 视觉体量终极调优：大幅放宽 Logo 尺寸上限使其更具视觉冲击力，适度缩小截图使其回归配角体量，并重新校准文字对齐。
 * 5. [UI] 完美居中：重构下半部“截图+文本”区域，实现整体水平居中，并让文本绝对垂直居中于截图。
 */
const sharp = require('sharp');
const fs = require('fs-extra');
const path = require('path');

/**
 * 辅助函数：清理文本，移除 SVG/XML 不兼容的特殊字符
 */
function sanitizeSvgText (text, maxLength = 350) {
    if (!text) return '';
    let cleaned = text
        .replace(/[\r\n\v\f]/g, ' ')
        .replace(/&[a-z0-9#]{2,8};/g, '')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .trim();
    if (cleaned.length > maxLength) {
        cleaned = cleaned.substring(0, maxLength - 3) + '...';
    }
    return cleaned;
}

/**
 * 核心修复算法：将长文本按指定像素宽度拆分为多行，生成 SVG 原生 <tspan> 渲染标签
 */
function wrapSvgTextNode (text, maxWidth, fontSize) {
    const lines = [];
    let currentLine = '';
    let currentWidth = 0;

    for (const char of text) {
        const charWidth = char.charCodeAt(0) > 255 ? fontSize : fontSize * 0.55;
        if (currentWidth + charWidth > maxWidth) {
            lines.push(currentLine);
            currentLine = char;
            currentWidth = charWidth;
        } else {
            currentLine += char;
            currentWidth += charWidth;
        }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
}

/**
 * 【终极边界扫描算法】：从左向右扫描，跳过边缘杂色，支持绿/黑/透明三种幕布
 */
function findLeftBoundary (data, width, height, filename) {
    const channels = 4;
    const scanRows = [0.25, 0.5, 0.75].map((p) => Math.floor(height * p));
    const boundaries = [];
    const startX = Math.floor(width * 0.05);

    for (const y of scanRows) {
        let boundX = 0;

        for (let x = startX; x < Math.floor(width * 0.6); x++) {
            const idx = (y * width + x) * channels;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const a = data[idx + 3];

            // 宽容的背景色判断：透明幕、绿幕、黑幕
            const isTransparent = a < 20;
            const isGreen = g > 80 && g > r + 20 && g > b + 20;
            const isBlack = r < 50 && g < 50 && b < 50 && a > 200;

            // 如果遇到【非背景色】，说明可能碰到真实的包装盒边缘了
            if (!isTransparent && !isGreen && !isBlack) {
                // 向前探路 10 个像素，防抖验证
                let isSolid = true;
                for (let step = 1; step <= 10; step++) {
                    const nextX = x + step;
                    if (nextX >= width) break;
                    const nIdx = (y * width + nextX) * channels;
                    const nr = data[nIdx];
                    const ng = data[nIdx + 1];
                    const nb = data[nIdx + 2];
                    const na = data[nIdx + 3];

                    if (
                        na < 20 ||
                        (ng > 80 && ng > nr + 20 && ng > nb + 20) ||
                        (nr < 50 && ng < 50 && nb < 50 && na > 200)
                    ) {
                        isSolid = false;
                        break;
                    }
                }

                if (isSolid) {
                    boundX = x;
                    break;
                }
            }
        }
        boundaries.push(boundX);
    }

    boundaries.sort((a, b) => a - b);
    const medianBoundary = boundaries[1];

    // 限制：截断点必须大于宽度的15%，否则说明全图无背景，取消处理
    const finalResult = medianBoundary < width * 0.15 ? 0 : medianBoundary;
    return finalResult;
}

/**
 * 辅助函数：生成工业标准的条形码 SVG 元素
 */
function generateBarcodeSvg (startX, startY) {
    const pattern = [2, 3, 1, 2, 4, 1, 3, 2, 1, 2, 3, 2, 1, 3, 2, 1, 4, 1, 2];
    let svg = '';
    let currentX = startX;
    for (const width of pattern) {
        svg += `<rect x="${currentX}" y="${startY}" width="${width}" height="35" fill="black" />`;
        currentX += width + 2;
    }
    return svg;
}

/**
 * 主处理函数
 */
async function processBoxTexture (texturePath, marqueePath, screenshotPath, introText) {
    if (!fs.existsSync(texturePath)) return;

    const { data, info } = await sharp(texturePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const width = info.width;
    const height = info.height;

    const filename = path.basename(texturePath);

    // 2. 确定背景边界
    const greenBoundaryX = findLeftBoundary(data, width, height, filename);
    if (greenBoundaryX === 0) return;

    let cleanGameName = path
        .basename(texturePath, path.extname(texturePath))
        .replace(/\[.*?\]|\(.*?\)/g, '')
        .trim();
    cleanGameName = sanitizeSvgText(cleanGameName, 50);

    const hasValidLogo = marqueePath && fs.existsSync(marqueePath);

    // 3. 【排版重构】截图体量缩小，凸显主角 Logo
    const shotW = Math.floor(greenBoundaryX * 0.32); // 宽度占比调回 32%
    const shotH = Math.floor(shotW * 0.75); // 严格锁定 4:3 比例

    let b64Screenshot;
    let hasRealScreenshot = false;

    if (screenshotPath && fs.existsSync(screenshotPath)) {
        try {
            const screenBuffer = await sharp(screenshotPath)
                .resize({ width: shotW - 6, height: shotH - 6, fit: 'cover' })
                .png()
                .toBuffer();
            b64Screenshot = screenBuffer.toString('base64');
            hasRealScreenshot = true;
        } catch (e) {
            console.warn(`[ImgProc] 真实截图处理异常 (${filename}): ${e.message}`);
        }
    }

    if (!hasRealScreenshot) {
        const cropBuffer = await sharp(data, { raw: { width, height, channels: 4 } })
            .extract({
                left: Math.floor(width * 0.7),
                top: Math.floor(height * 0.25),
                width: Math.floor(width * 0.25),
                height: Math.floor(height * 0.25)
            })
            .resize({ width: shotW - 6, height: shotH - 6, fit: 'cover' })
            .png()
            .toBuffer();
        b64Screenshot = cropBuffer.toString('base64');
    }

    // 4. 清理并准备介绍文本
    const defaultIntro =
        'ゲームの詳細情報がありません。未知の冒険が今、始まる！多彩なアクションを駆使して、立ちはだかる強敵を打ち倒せ。';
    // 【修改】：将文本最大截断字符数放宽到 600，确保有足够的字数填补 11 行的空间
    const introTextToPrint = introText ? sanitizeSvgText(introText, 600) : sanitizeSvgText(defaultIntro, 600);

    const leftMargin = 28;
    const textAreaWidth = greenBoundaryX * 0.85 - leftMargin;
    const fontSize = 9.5;
    // 【修改】：将限制显示的最多行数增加两行，从 9 行放宽到 11 行
    const introLines = wrapSvgTextNode(introTextToPrint, textAreaWidth, fontSize).slice(0, 11);

    let introSvgSpan = '';
    introLines.forEach((line, idx) => {
        introSvgSpan += `<tspan x="0" dy="${idx === 0 ? '0' : '1.6em'}">${line}</tspan>`;
    });

    const paperTop = '#fdfdfa';
    const paperBottom = '#ecece4';
    const footerHeight = 135;
    const footerY = height - footerHeight;

    // 【垂直居中与水平居中重构】
    const descY = Math.floor(height * 0.34);
    const highlightY = Math.floor(height * 0.56);

    // 整个下半部模块水平居中：文字靠右贴近 47%，图片靠左贴近 51%，中间留白 4%
    const highlightTextX = Math.floor(greenBoundaryX * 0.47);
    const highlightImgX = Math.floor(greenBoundaryX * 0.51);

    // 文字绝对垂直居中算法：截图高度一半 减去 文字块整体高度一半（4行文字约40px高度 -> 中心距顶部约20px）
    const textCenterOffsetY = Math.floor(shotH / 2) - 20;

    // --- 核心修改：生成极具质感的 SVG 排版 ---
    const backCoverSvg = `
    <svg width="${greenBoundaryX}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="mainBg" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="${paperTop}" />
                <stop offset="100%" stop-color="${paperBottom}" />
            </linearGradient>
            <filter id="matteFiber">
                <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="3" stitchTiles="stitch"/>
                <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.08 0"/>
            </filter>
            <pattern id="noise" width="4" height="4" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="0.5" fill="#000" opacity="0.03" />
                <circle cx="3" cy="3" r="0.5" fill="#000" opacity="0.05" />
            </pattern>
            <clipPath id="clipScreen">
                <rect x="3" y="3" width="${shotW - 6}" height="${shotH - 6}" rx="1" />
            </clipPath>
        </defs>

        <rect x="0" y="0" width="${greenBoundaryX}" height="${height}" fill="url(#mainBg)" />
        <rect x="0" y="0" width="${greenBoundaryX}" height="${height}" fill="url(#noise)" />
        <rect x="0" y="0" width="${greenBoundaryX}" height="${height}" fill="url(#mainBg)" filter="url(#matteFiber)" />

        ${
    !hasValidLogo
        ? `
            <g transform="translate(${greenBoundaryX / 2}, ${height * 0.18})">
                <text x="1" y="2" font-family="sans-serif" font-weight="900" font-size="16" fill="#000" opacity="0.15" text-anchor="middle" letter-spacing="1">${cleanGameName}</text>
                <text x="0" y="0" font-family="sans-serif" font-weight="900" font-size="16" fill="#222" text-anchor="middle" letter-spacing="1">${cleanGameName}</text>
            </g>
        `
        : ''
}

        <g transform="translate(${leftMargin}, ${descY})">
            <text x="0" y="0" font-family="sans-serif" font-weight="900" font-size="11" fill="#c0392b">DESCRIPTION / ゲーム紹介</text>
            <text x="0" y="20" font-family="sans-serif" font-weight="bold" font-size="${fontSize}" fill="#333">
                ${introSvgSpan}
            </text>
        </g>

        <g transform="translate(0, ${highlightY})">
            <g transform="translate(0, ${textCenterOffsetY})">
                <text x="${highlightTextX}" y="0" font-family="sans-serif" font-weight="900" font-size="11" fill="#222" text-anchor="end">HIGHLIGHTS / ゲームの魅力</text>
                <text x="${highlightTextX}" y="16" font-family="sans-serif" font-weight="bold" font-size="9" fill="#555" text-anchor="end">洗練されたシステムと直感的な操作感。</text>
                <text x="${highlightTextX}" y="28" font-family="sans-serif" font-weight="bold" font-size="9" fill="#555" text-anchor="end">初心者から上級者まで誰もが夢中になる、</text>
                <text x="${highlightTextX}" y="40" font-family="sans-serif" font-weight="bold" font-size="9" fill="#555" text-anchor="end">奥深いゲームプレイを体験しよう！</text>
            </g>
            
            <g transform="translate(${highlightImgX}, 0)">
                <rect x="2" y="4" width="${shotW}" height="${shotH}" fill="#000" opacity="0.3" rx="2" />
                <rect x="0" y="0" width="${shotW}" height="${shotH}" fill="#fff" rx="2" />
                <image x="3" y="3" width="${shotW - 6}" height="${shotH - 6}" href="data:image/png;base64,${b64Screenshot}" preserveAspectRatio="xMidYMid slice" clip-path="url(#clipScreen)" />
                <rect x="3" y="3" width="${shotW - 6}" height="${shotH - 6}" fill="#000" opacity="0.1" rx="1" />
            </g>
        </g>

        <rect x="0" y="${footerY}" width="${greenBoundaryX}" height="${footerHeight}" fill="#fcfcfc" />
        <line x1="0" y1="${footerY}" x2="${greenBoundaryX}" y2="${footerY}" stroke="#e0e0e0" stroke-width="2" />

        <g transform="translate(15, ${footerY + 15})">
            <rect width="45" height="65" fill="#fff" stroke="#111" stroke-width="2" />
            <rect y="0" width="45" height="20" fill="#111" />
            <text x="22.5" y="14" font-family="sans-serif" font-size="10" fill="#fff" font-weight="bold" text-anchor="middle">RATING</text>
            <text x="22.5" y="52" font-family="sans-serif" font-size="34" fill="#111" font-weight="900" text-anchor="middle">A</text>
        </g>

        <g transform="translate(75, ${footerY + 15})">
            <text x="0" y="10" font-family="sans-serif" font-size="11" fill="#c0392b" font-weight="900">WARNING / 安全のための注意</text>
            <text x="0" y="26" font-family="sans-serif" font-size="8.5" fill="#444" font-weight="bold">If you have epilepsy or have had seizures, consult a doctor.</text>
            <text x="0" y="38" font-family="sans-serif" font-size="8.5" fill="#555">Please read the instruction manual carefully before using.</text>
            <text x="0" y="50" font-family="sans-serif" font-size="8.5" fill="#555">ご使用前に必ず取扱説明書をよくお読みいただき、</text>
            <text x="0" y="62" font-family="sans-serif" font-size="8.5" fill="#555">正しい使用方法でご愛用ください。</text>
        </g>

        <g transform="translate(${greenBoundaryX - 95}, ${footerY + 15})">
            <rect width="80" height="50" fill="#fff" />
            ${generateBarcodeSvg(4, 5)}
            <text x="5" y="48" font-family="monospace" font-size="9" fill="#000" letter-spacing="3">4902370</text>
        </g>

        <rect x="0" y="${height - 30}" width="${greenBoundaryX}" height="30" fill="#151515" />
        <text x="15" y="${height - 18}" font-family="sans-serif" font-size="8" fill="#aaa">© ${new Date().getFullYear()} OFFICIAL LICENSED PRODUCT. ALL RIGHTS RESERVED. MADE IN JAPAN.</text>
        <text x="15" y="${height - 8}" font-family="sans-serif" font-size="8" fill="#777">FOR SALE AND USE IN JAPAN ONLY. COMMERCIAL USE AND RENTAL ARE PROHIBITED.</text>

        <rect x="0" y="0" width="${greenBoundaryX}" height="${height}" fill="none" stroke="#222" stroke-width="1.5" stroke-opacity="0.3" />
    </svg>`;

    const backCoverBuffer = Buffer.from(backCoverSvg.trim());

    const compositeOps = [];

    compositeOps.push({
        input: backCoverBuffer,
        top: 0,
        left: 0
    });

    // 图层2：Logo 尺寸和边界全面放开，使其更加宏伟
    if (hasValidLogo) {
        try {
            const rawLogo = sharp(marqueePath);
            const trimmedBuffer = await rawLogo.trim({ threshold: 30 }).png().toBuffer();

            // 【排版修改】: 宽度上限放到 82%，高度上限放到 22%，极大增强 Logo 体感
            const maxLogoW = Math.floor(greenBoundaryX * 0.82);
            const maxLogoH = Math.floor(height * 0.22);

            const resizedPipeline = sharp(trimmedBuffer).resize({
                width: maxLogoW,
                height: maxLogoH,
                fit: 'inside',
                withoutEnlargement: true
            });

            const finalLogoBuffer = await resizedPipeline.png().toBuffer();
            const finalLogoMeta = await sharp(finalLogoBuffer).metadata();

            const logoLeft = Math.floor((greenBoundaryX - finalLogoMeta.width) / 2);
            // 向上稍微收缩一点边距，让巨大的 Logo 也能装得下
            const logoTop = Math.max(35, Math.floor((height * 0.26 - finalLogoMeta.height) / 2));

            const shadowBuffer = await sharp(finalLogoBuffer).modulate({ brightness: 0 }).blur(1.5).png().toBuffer();

            compositeOps.push({
                input: shadowBuffer,
                top: logoTop + 2,
                left: logoLeft + 2
            });

            compositeOps.push({
                input: finalLogoBuffer,
                top: logoTop,
                left: logoLeft
            });
        } catch (e) {
            console.warn(`[ImgProc] Logo处理异常 (${filename}): ${e.message}`);
        }
    }

    const boxBodyWidth = width - greenBoundaryX;
    const boxBodyBuffer = await sharp(data, { raw: { width, height, channels: 4 } })
        .extract({ left: greenBoundaryX, top: 0, width: boxBodyWidth, height })
        .png()
        .toBuffer();

    compositeOps.push({
        input: boxBodyBuffer,
        top: 0,
        left: greenBoundaryX
    });

    const finalBuffer = await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 255 }
        }
    })
        .composite(compositeOps)
        .png()
        .withMetadata({
            exif: {
                IFD0: { Software: 'RetroRomHub-AutoBox' }
            }
        })
        .toBuffer();

    await fs.writeFile(texturePath, finalBuffer);
}

module.exports = { processBoxTexture };
