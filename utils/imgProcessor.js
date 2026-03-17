/**
 * imgProcessor.js
 * 负责处理缺失背面的包装盒图片，生成拟真的通用实体背板
 * * 修改记录：
 * 1. [Fix] 彻底移除易出错的背景色提取逻辑，统一使用“复古米白纸板”渐变底色。
 * 2. [Feat] 移除线条骨架，使用真实的日文游戏宣传语进行交错排版。
 * 3. [Feat] 增加终极容错：如果游戏缺失 Logo 图片，自动使用游戏名称生成带有印刷质感的文字标题占位。
 * 4. [Feat] 植入真实的游戏截图：优先使用下载的真实截图填充第二个相框，提升拟真度。
 * 5. [UI] 优化了底部文字块的排版，采用右对齐增强页面视觉平衡。
 */
const sharp = require('sharp');
const fs = require('fs-extra');
const path = require('path');

/**
 * 辅助函数：扫描每一行的像素，找到绿色区域的右边界
 */
function findGreenBoundary (data, width, height) {
    const channels = 4;
    const scanRows = [Math.floor(height * 0.25), Math.floor(height * 0.5), Math.floor(height * 0.75)];

    const boundaries = [];
    const startX = Math.floor(width * 0.6);

    for (const y of scanRows) {
        let foundX = 0;
        for (let x = startX; x >= 0; x--) {
            const idx = (y * width + x) * channels;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];

            if (g > 150 && g > r + 60 && g > b + 60) {
                foundX = x;
                break;
            }
        }
        boundaries.push(foundX);
    }

    boundaries.sort((a, b) => a - b);
    const medianBoundary = boundaries[1];
    return medianBoundary < width * 0.05 ? 0 : medianBoundary;
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
 * 新增了 screenshotPath 参数，用于接收真实下载的游戏截图
 */
async function processBoxTexture (texturePath, marqueePath, screenshotPath) {
    if (!fs.existsSync(texturePath)) return;

    // 1. 读取原图数据
    const { data, info } = await sharp(texturePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const width = info.width;
    const height = info.height;

    // 2. 确定绿幕边界 (缺失背面的精确宽度)
    const greenBoundaryX = findGreenBoundary(data, width, height);
    if (greenBoundaryX === 0) return;

    const filename = path.basename(texturePath);
    const cleanGameName = path
        .basename(texturePath, path.extname(texturePath))
        .replace(/\[.*?\]|\(.*?\)/g, '')
        .trim();

    console.log(`[ImgProc] 开始生成终极拟真米白背板: ${filename}`);

    const hasValidLogo = marqueePath && fs.existsSync(marqueePath);

    // 3. 截图1：永远从正面封面截取一块图像作为假截图1 (维持画风一致)
    const crop1Buffer = await sharp(data, { raw: { width, height, channels: 4 } })
        .extract({
            left: Math.floor(width * 0.7),
            top: Math.floor(height * 0.25),
            width: Math.floor(width * 0.25),
            height: Math.floor(height * 0.25)
        })
        .png()
        .toBuffer();
    const b64Crop1 = crop1Buffer.toString('base64');

    // 4. 截图2：优先使用真实的下载截图，没有则回退到封面截取
    let b64Crop2;
    let hasRealScreenshot = false;

    if (screenshotPath && fs.existsSync(screenshotPath)) {
        try {
            // 读取真实截图并裁切/缩放以填满相框
            const screenBuffer = await sharp(screenshotPath)
                .resize({
                    width: Math.floor(greenBoundaryX * 0.38 - 6),
                    height: Math.floor(height * 0.15 - 6),
                    fit: 'cover' // 保证填满不留白
                })
                .png()
                .toBuffer();
            b64Crop2 = screenBuffer.toString('base64');
            hasRealScreenshot = true;
        } catch (e) {
            console.warn(`[ImgProc] 真实截图处理异常 (${filename}): ${e.message}`);
        }
    }

    // 兜底逻辑：如果未开启同步截图或截图损坏，退回到原本的封面截取逻辑
    if (!hasRealScreenshot) {
        const crop2Buffer = await sharp(data, { raw: { width, height, channels: 4 } })
            .extract({
                left: Math.floor(width * 0.65),
                top: Math.floor(height * 0.6),
                width: Math.floor(width * 0.3),
                height: Math.floor(height * 0.2)
            })
            .png()
            .toBuffer();
        b64Crop2 = crop2Buffer.toString('base64');
    }

    // 定义极其正宗的复古包装盒底色（上部微暖白，下部微灰白）
    const paperTop = '#fdfdfa';
    const paperBottom = '#ecece4';

    const footerHeight = 135;
    const footerY = height - footerHeight;

    // --- 核心修改：极其拟真的 SVG 排版 ---
    const backCoverSvg = `
    <svg width="${greenBoundaryX}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="mainBg" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="${paperTop}" />
                <stop offset="100%" stop-color="${paperBottom}" />
            </linearGradient>

            <pattern id="noise" width="4" height="4" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="0.5" fill="#000" opacity="0.03" />
                <circle cx="3" cy="3" r="0.5" fill="#000" opacity="0.05" />
            </pattern>

            <clipPath id="clipScreen">
                <rect x="3" y="3" width="${greenBoundaryX * 0.38 - 6}" height="${height * 0.15 - 6}" rx="1" />
            </clipPath>
        </defs>

        <rect x="0" y="0" width="${greenBoundaryX}" height="${height}" fill="url(#mainBg)" />
        <rect x="0" y="0" width="${greenBoundaryX}" height="${height}" fill="url(#noise)" />

        ${
    !hasValidLogo
        ? `
            <g transform="translate(${greenBoundaryX / 2}, ${height * 0.15})">
                <text x="1" y="2" font-family="sans-serif" font-weight="900" font-size="16" fill="#000" opacity="0.15" text-anchor="middle" letter-spacing="1">${cleanGameName}</text>
                <text x="0" y="0" font-family="sans-serif" font-weight="900" font-size="16" fill="#222" text-anchor="middle" letter-spacing="1">${cleanGameName}</text>
            </g>
        `
        : ''
}

        <g transform="translate(15, ${height * 0.35})">
            <g transform="rotate(-2)">
                <rect x="2" y="4" width="${greenBoundaryX * 0.38}" height="${height * 0.15}" fill="#000" opacity="0.3" rx="2" />
                <rect x="0" y="0" width="${greenBoundaryX * 0.38}" height="${height * 0.15}" fill="#fff" rx="2" />
                <image x="3" y="3" width="${greenBoundaryX * 0.38 - 6}" height="${height * 0.15 - 6}" href="data:image/png;base64,${b64Crop1}" preserveAspectRatio="xMidYMid slice" clip-path="url(#clipScreen)" />
                <rect x="3" y="3" width="${greenBoundaryX * 0.38 - 6}" height="${height * 0.15 - 6}" fill="#000" opacity="0.1" rx="1" />
            </g>
            
            <g transform="translate(${greenBoundaryX * 0.4 + 5}, 10)">
                <text x="0" y="0" font-family="sans-serif" font-weight="900" font-size="12" fill="#222">未知の冒険が今、始まる！</text>
                <text x="0" y="16" font-family="sans-serif" font-weight="bold" font-size="9" fill="#444">多彩なアクションを駆使して、</text>
                <text x="0" y="28" font-family="sans-serif" font-weight="bold" font-size="9" fill="#444">立ちはだかる強敵を打ち倒せ。</text>
                <text x="0" y="40" font-family="sans-serif" font-weight="bold" font-size="9" fill="#444">隠された謎を解き明かそう！</text>
            </g>
        </g>

        <g transform="translate(15, ${height * 0.54})">
            <g transform="translate(0, 10)">
                <text x="${greenBoundaryX * 0.45}" y="0" font-family="sans-serif" font-weight="900" font-size="12" fill="#222" text-anchor="end">通信機能で広がる世界</text>
                <text x="${greenBoundaryX * 0.45}" y="16" font-family="sans-serif" font-weight="bold" font-size="9" fill="#444" text-anchor="end">友達とアイテムを交換したり、</text>
                <text x="${greenBoundaryX * 0.45}" y="28" font-family="sans-serif" font-weight="bold" font-size="9" fill="#444" text-anchor="end">白熱の対戦プレイも可能！</text>
                <text x="${greenBoundaryX * 0.45}" y="40" font-family="sans-serif" font-weight="bold" font-size="9" fill="#444" text-anchor="end">最強の称号を目指して戦おう。</text>
            </g>
            
            <g transform="translate(${greenBoundaryX * 0.5}, 0) rotate(2)">
                <rect x="2" y="4" width="${greenBoundaryX * 0.38}" height="${height * 0.15}" fill="#000" opacity="0.3" rx="2" />
                <rect x="0" y="0" width="${greenBoundaryX * 0.38}" height="${height * 0.15}" fill="#fff" rx="2" />
                <image x="3" y="3" width="${greenBoundaryX * 0.38 - 6}" height="${height * 0.15 - 6}" href="data:image/png;base64,${b64Crop2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#clipScreen)" />
                <rect x="3" y="3" width="${greenBoundaryX * 0.38 - 6}" height="${height * 0.15 - 6}" fill="#000" opacity="0.1" rx="1" />
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
    const backCoverBuffer = Buffer.from(backCoverSvg);

    // 5. 前景去绿
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (g > 150 && g > r + 60 && g > b + 60) {
            data[i + 3] = 0;
        }
    }

    const compositeOps = [];

    // 第一层：铺上背板
    compositeOps.push({ input: backCoverBuffer, top: 0, left: 0 });

    // 第二层：贴上高清 Logo
    if (hasValidLogo) {
        try {
            const rawLogo = sharp(marqueePath);
            const trimmedBuffer = await rawLogo.trim({ threshold: 30 }).toBuffer();

            const maxLogoW = Math.floor(greenBoundaryX * 0.7);
            const maxLogoH = Math.floor(height * 0.26);

            const resizedPipeline = sharp(trimmedBuffer).resize({
                width: maxLogoW,
                height: maxLogoH,
                fit: 'inside',
                withoutEnlargement: true
            });

            const finalLogoBuffer = await resizedPipeline.toBuffer();
            const finalLogoMeta = await sharp(finalLogoBuffer).metadata();

            const logoLeft = Math.floor((greenBoundaryX - finalLogoMeta.width) / 2);
            const logoTop = Math.max(25, Math.floor((height * 0.26 - finalLogoMeta.height) / 2));

            const shadowBuffer = await sharp(finalLogoBuffer).modulate({ brightness: 0 }).blur(1.5).toBuffer();

            compositeOps.push({ input: shadowBuffer, top: logoTop + 2, left: logoLeft + 2 });
            compositeOps.push({ input: finalLogoBuffer, top: logoTop, left: logoLeft });
        } catch (e) {
            console.warn(`[ImgProc] Logo处理异常 (${filename}): ${e.message}`);
        }
    }

    // 第三层：盖上去绿原图
    compositeOps.push({
        input: data,
        raw: { width, height, channels: 4 },
        top: 0,
        left: 0
    });

    // 6. 最终输出画布 (保留了上次添加的 EXIF 标记)
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
                IFD0: {
                    Software: 'RetroRomHub-AutoBox'
                }
            }
        })
        .toBuffer();

    await fs.writeFile(texturePath, finalBuffer);
}

module.exports = { processBoxTexture };
