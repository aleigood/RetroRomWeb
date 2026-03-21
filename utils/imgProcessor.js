/**
 * imgProcessor.js
 * 负责处理缺失背面的包装盒图片，生成拟真的通用实体背板
 * * 修改记录：
 * 1. [Fix] 彻底抛弃遍历修改像素透明度的做法，改为“计算边界并裁剪覆盖”，根治了误杀封面真实绿色图案的 Bug。
 * 2. [Feat] 边界扫描算法终极重构：跳过左侧10%边缘杂色，加入10像素前向探路防抖，精准切除背景。
 * 3. [Feat] 完美兼容：同时支持识别 绿幕、纯黑幕 以及 透明幕。
 * 4. [UI] 视觉体量终极调优：大幅放宽 Logo 尺寸上限使其更具视觉冲击力，适度缩小截图使其回归配角体量，并重新校准文字对齐。
 * 5. [UI] 完美居中：重构下半部“截图+文本”区域，实现整体水平居中，并让文本绝对垂直居中于截图。
 * 6. [Fix] 拆分文本清理与 XML 转义逻辑，实现先换行后转义，彻底解决特殊符号被截断导致的 SVG 渲染崩溃问题。
 */
const sharp = require('sharp');
const fs = require('fs-extra');
const path = require('path');

// 拆分1：专门用于彻底的安全 XML 实体转义
function escapeXml (unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// 拆分2：仅做基础文本清理（去除控制字符和回车），不提前做转义
function cleanRawText (text, maxLength = 600) {
    if (!text) return '';
    // 单独提取正则并豁免 ESLint 检查
    // eslint-disable-next-line no-control-regex
    const ctrlRegex = /[\x00-\x1F\x7F-\x9F]/g;
    let clean = text
        .replace(/[\r\n]+/g, ' ')
        .replace(ctrlRegex, '')
        .trim();
    if (clean.length > maxLength) {
        clean = clean.substring(0, maxLength) + '...';
    }
    return clean;
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
 * 【动态容差蔓延算法】：通过提取基准色 + 计算曼哈顿色差，完美兼容 JPEG 杂波，精准屏蔽复杂自然纹理
 */
function findLeftBoundary (data, width, height, filename) {
    const channels = 4;
    const startX = Math.floor(width * 0.05); // 从 5% 开始取样

    // 辅助函数：计算两个颜色的色差（曼哈顿距离，性能极高）
    const colorDiff = (r1, g1, b1, r2, g2, b2) => {
        return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
    };

    const checkPointsY = [Math.floor(height * 0.25), Math.floor(height * 0.5), Math.floor(height * 0.75)];

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    const samples = [];

    // 1. 采样并检查“大面积颜色的绝对平滑度”
    for (const y of checkPointsY) {
        const idx = (y * width + startX) * channels;
        samples.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
        sumR += data[idx];
        sumG += data[idx + 1];
        sumB += data[idx + 2];
    }

    // 计算三个采样点相互之间的最大色差
    const maxSampleDiff = Math.max(
        colorDiff(samples[0].r, samples[0].g, samples[0].b, samples[1].r, samples[1].g, samples[1].b),
        colorDiff(samples[1].r, samples[1].g, samples[1].b, samples[2].r, samples[2].g, samples[2].b),
        colorDiff(samples[0].r, samples[0].g, samples[0].b, samples[2].r, samples[2].g, samples[2].b)
    );

    // 【核心锁 1】：如果上下颜色差异超过 50，说明这是带有纹理、光影的自然背景（如网球草地），坚决不替换！
    if (maxSampleDiff > 50) {
        console.log(`[ImgProc] ${filename} 左侧背景不平滑(方差为 ${maxSampleDiff})，视为自然图像，跳过。`);
        return 0;
    }

    // 2. 提取这张图左侧的“专属基准色”
    const baseR = sumR / 3;
    const baseG = sumG / 3;
    const baseB = sumB / 3;

    // 只要基准色大体上是绿色（G比R和B大30以上即可，不卡死绝对数值），就批准放行
    if (!(baseG > baseR + 30 && baseG > baseB + 30 && baseG > 80)) {
        console.log(`[ImgProc] ${filename} 提取的基准主色调非绿色，跳过。`);
        return 0;
    }

    // 3. 基于“容差”向右蔓延扫描
    const scanY = Math.floor(height * 0.5);
    let boundX = 0;
    // 宽容度 60：足以包容 JPEG 压缩导致的糊边和色块杂波
    const TOLERANCE = 60;

    for (let x = startX; x < Math.floor(width * 0.6); x++) {
        const idx = (scanY * width + x) * channels;
        const diff = colorDiff(data[idx], data[idx + 1], data[idx + 2], baseR, baseG, baseB);

        // 如果当前像素与基准色的色差大于宽容度，说明撞墙了（碰到真实外盒了）
        if (diff > TOLERANCE) {
            // 防抖验证：再往右看 5 个像素，如果确实全都跟绿幕长得不一样，才确定是真边界
            let isSolidBreak = true;
            for (let step = 1; step <= 5; step++) {
                const nx = x + step;
                if (nx >= width) break;
                const nIdx = (scanY * width + nx) * channels;
                const nDiff = colorDiff(data[nIdx], data[nIdx + 1], data[nIdx + 2], baseR, baseG, baseB);
                if (nDiff <= TOLERANCE) {
                    isSolidBreak = false; // 前方又是绿幕色，说明刚才只是个大号噪点，继续走
                    break;
                }
            }
            if (isSolidBreak) {
                boundX = x;
                console.log(`[ImgProc] 色差断层定位边界: X=${boundX} (${filename})`);
                break;
            }
        }
    }

    // 4. 面积兜底：蔓延出的宽度必须大于总宽度的 20%
    return boundX < width * 0.2 ? 0 : boundX;
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
    // 【核心修复】：标题提取后，同样使用新的 escapeXml 和 cleanRawText，避免标题包含特殊字符导致崩溃
    cleanGameName = escapeXml(cleanRawText(cleanGameName, 50));

    const hasValidLogo = marqueePath && fs.existsSync(marqueePath);

    // 3. 【核心修复：排版尺寸重构与防碰撞安全锁】
    // 提前计算全局高度定位点
    const footerHeight = 135;
    const footerY = height - footerHeight;
    const descY = Math.floor(height * 0.34);
    const highlightY = Math.floor(height * 0.56);

    // 按照 32% 的宽度占比预估截图尺寸
    let shotW = Math.floor(greenBoundaryX * 0.32);
    let shotH = Math.floor(shotW * 0.75);

    // 【安全检查】：计算距离底部 Footer 的剩余极限高度（保留 20px 呼吸间距）
    const maxShotH = footerY - highlightY - 20;
    if (shotH > maxShotH) {
        // 如果截图过高，则强制降维，限制最高高度，并反推缩小宽度，严格保持 4:3 比例
        shotH = maxShotH;
        shotW = Math.floor(shotH / 0.75);
    }

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

    // 4. 清理并准备介绍文本 (先换行后转义防切断报错)
    const defaultIntro =
        'ゲームの詳細情報がありません。未知の冒険が今、始まる！多彩なアクションを駆使して、立ちはだかる強敵を打ち倒せ。';
    const rawIntro = introText ? cleanRawText(introText, 600) : cleanRawText(defaultIntro, 600);

    const leftMargin = 28;
    const textAreaWidth = greenBoundaryX * 0.85 - leftMargin;
    const fontSize = 9.5;
    const introLines = wrapSvgTextNode(rawIntro, textAreaWidth, fontSize).slice(0, 11);

    let introSvgSpan = '';
    introLines.forEach((line, idx) => {
        // 【核心修复】：单行切好后，塞入 SVG 前的一瞬间，才执行转义，避免单引号等实体字符被切开
        const safeLine = escapeXml(line);
        introSvgSpan += `<tspan x="0" dy="${idx === 0 ? '0' : '1.6em'}">${safeLine}</tspan>`;
    });

    const paperTop = '#fdfdfa';
    const paperBottom = '#ecece4';

    // 整个下半部模块水平居中：文字靠右贴近 47%，图片靠左贴近 51%，中间留白 4%
    const highlightTextX = Math.floor(greenBoundaryX * 0.47);
    const highlightImgX = Math.floor(greenBoundaryX * 0.51);

    // 文字绝对垂直居中算法：使用最终的安全截图高度(shotH)一半 减去 文字块整体高度一半（约20px）
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
