const sharp = require('sharp');
const fs = require('fs-extra');
const path = require('path');

/**
 * 辅助函数：扫描每一行的像素，找到绿色区域的右边界
 */
function findGreenBoundary (data, width, height) {
    const channels = 4;
    // 扫描三行（25%, 50%, 75% 高度处）
    const scanRows = [Math.floor(height * 0.25), Math.floor(height * 0.5), Math.floor(height * 0.75)];

    const boundaries = [];
    const startX = Math.floor(width * 0.6); // 从 60% 处向左扫

    for (const y of scanRows) {
        let foundX = 0;
        for (let x = startX; x >= 0; x--) {
            const idx = (y * width + x) * channels;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];

            // 绿色判定
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
 * 主处理函数
 */
async function processBoxTexture (texturePath, marqueePath) {
    if (!fs.existsSync(texturePath)) return;

    // 1. 读取数据
    const { data, info } = await sharp(texturePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const width = info.width;
    const height = info.height;

    // 2. 确定绿幕边界
    const greenBoundaryX = findGreenBoundary(data, width, height);

    if (greenBoundaryX === 0) {
        return;
    }

    // --- 调试日志 Start ---
    const filename = path.basename(texturePath);
    console.log(`\n[ImgProc] === 开始处理: ${filename} ===`);
    console.log(`[ImgProc] 画布尺寸: ${width}x${height}`);
    console.log(`[ImgProc] 绿幕容器宽度 (BoundaryX): ${greenBoundaryX}`);
    // --- 调试日志 End ---

    // 3. 准备背景
    const backgroundBuffer = Buffer.alloc(width * height * 4);
    const startColor = { r: 45, g: 45, b: 50 };
    const endColor = { r: 5, g: 5, b: 5 };

    for (let i = 0; i < data.length; i += 4) {
        // 背景渐变
        const pIndex = i / 4;
        const x = pIndex % width;
        const y = Math.floor(pIndex / width);
        const factor = (x / width + y / height) / 2;

        backgroundBuffer[i] = startColor.r + (endColor.r - startColor.r) * factor;
        backgroundBuffer[i + 1] = startColor.g + (endColor.g - startColor.g) * factor;
        backgroundBuffer[i + 2] = startColor.b + (endColor.b - startColor.b) * factor;
        backgroundBuffer[i + 3] = 255;

        // 前景去绿
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (g > 150 && g > r + 60 && g > b + 60) {
            data[i + 3] = 0; // 透明
        }
    }

    // 4. 合成 Logo
    const compositeOps = [];

    if (marqueePath && fs.existsSync(marqueePath)) {
        try {
            // A. 读取原始 Logo
            const rawLogo = sharp(marqueePath);
            const rawMeta = await rawLogo.metadata();

            // B. 执行强力 Trim (阈值 30)
            const trimmedBuffer = await rawLogo.trim({ threshold: 30 }).toBuffer();
            const trimmedMeta = await sharp(trimmedBuffer).metadata();

            console.log(`[ImgProc] Logo 原始尺寸: ${rawMeta.width}x${rawMeta.height}`);
            console.log(
                `[ImgProc] Logo 裁切后尺寸: ${trimmedMeta.width}x${trimmedMeta.height} (减少了 ${rawMeta.width - trimmedMeta.width}px 宽度)`
            );

            // C. 计算目标尺寸 (FIXED: 宽度限制为容器的 70%)
            const maxLogoW = Math.floor(greenBoundaryX * 0.7);
            // 高度也保留一定余地 (90%)，防止填满上下边缘
            const maxLogoH = Math.floor(height * 0.9);

            // D. Resize
            const resizedPipeline = sharp(trimmedBuffer).resize({
                width: maxLogoW,
                height: maxLogoH,
                fit: 'inside',
                withoutEnlargement: true
            });

            // 先输出 Buffer 确保获取到的是缩放后的真实尺寸
            const finalLogoBuffer = await resizedPipeline.toBuffer();
            const finalLogoMeta = await sharp(finalLogoBuffer).metadata();

            // E. 计算居中位置
            const logoLeft = Math.floor((greenBoundaryX - finalLogoMeta.width) / 2);
            const logoTop = Math.floor((height - finalLogoMeta.height) / 2);

            console.log(`[ImgProc] Logo 最终渲染尺寸: ${finalLogoMeta.width}x${finalLogoMeta.height}`);
            console.log(`[ImgProc] Logo 坐标: Left=${logoLeft}, Top=${logoTop}`);
            console.log(
                `[ImgProc] (验证居中: ${logoLeft} + ${finalLogoMeta.width / 2} = ${logoLeft + finalLogoMeta.width / 2}, 容器中心: ${greenBoundaryX / 2})`
            );

            compositeOps.push({
                input: finalLogoBuffer,
                top: logoTop,
                left: logoLeft
            });
        } catch (e) {
            console.warn(`[ImgProc] Logo处理异常: ${e.message}`);
        }
    } else {
        console.log('[ImgProc] 未找到 Logo 文件，跳过合成');
    }

    compositeOps.push({
        input: data,
        raw: { width, height, channels: 4 }
    });

    // 5. 输出
    const finalBuffer = await sharp(backgroundBuffer, {
        raw: { width, height, channels: 4 }
    })
        .composite(compositeOps)
        .png()
        .toBuffer();

    await fs.writeFile(texturePath, finalBuffer);
    console.log('[ImgProc] === 处理完成 ===\n');
}

module.exports = { processBoxTexture };
