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
 * 主处理函数
 */
async function processBoxTexture (texturePath, marqueePath) {
    if (!fs.existsSync(texturePath)) return;

    // 1. 读取数据
    const { data, info } = await sharp(texturePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const width = info.width;
    const height = info.height;

    // 2. 确定绿幕边界 (计算出缺失背面的精确宽度)
    const greenBoundaryX = findGreenBoundary(data, width, height);
    if (greenBoundaryX === 0) return;

    const filename = path.basename(texturePath);

    // 恢复并增加处理开始的日志提示
    console.log(`[ImgProc] 开始处理: ${filename}`);

    // 3. 提取右侧正面封面
    const extractLeft = Math.floor(width * 0.6);
    const extractWidth = width - extractLeft;

    // --- 核心修改：精确计算 1.6 倍等比例放大 ---
    const scale = 1.6;
    const scaledW = Math.floor(extractWidth * scale);
    const scaledH = Math.floor(height * scale);

    // 确保放大后的尺寸足以覆盖左侧绿幕区 (安全兜底)
    const finalW = Math.max(scaledW, greenBoundaryX);
    const finalH = Math.max(scaledH, height);

    // 生成专属毛玻璃补丁
    const patchBuffer = await sharp(data, { raw: { width, height, channels: 4 } })
        // A. 提取原图右侧的正面封面
        .extract({ left: extractLeft, top: 0, width: extractWidth, height })
        // B. 等比例放大 1.6 倍
        .resize({ width: finalW, height: finalH, fit: 'fill' })
        // C. 从 1.6 倍大图的正中间，精确裁切出刚好能塞入绿幕区的长方形
        .extract({
            left: Math.floor((finalW - greenBoundaryX) / 2),
            top: Math.floor((finalH - height) / 2),
            width: greenBoundaryX,
            height
        })
        // D. 添加模糊和压暗质感
        .blur(40)
        .modulate({ brightness: 0.5 })
        .png() // 转换为 png Buffer 以保证合成层不出现通道冲突
        .toBuffer();

    // 4. 前景去绿 (将原图中绿色部分变透明)
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (g > 150 && g > r + 60 && g > b + 60) {
            data[i + 3] = 0; // 透明
        }
    }

    // 5. 合成图层队列
    const compositeOps = [];

    // 第一层：铺上刚刚生成的 1.6x 毛玻璃补丁 (严格贴在最左侧的空缺处)
    compositeOps.push({
        input: patchBuffer,
        top: 0,
        left: 0
    });

    // 第二层：居中贴上高清 Logo
    if (marqueePath && fs.existsSync(marqueePath)) {
        try {
            const rawLogo = sharp(marqueePath);
            const trimmedBuffer = await rawLogo.trim({ threshold: 30 }).toBuffer();

            const maxLogoW = Math.floor(greenBoundaryX * 0.7);
            const maxLogoH = Math.floor(height * 0.9);

            const resizedPipeline = sharp(trimmedBuffer).resize({
                width: maxLogoW,
                height: maxLogoH,
                fit: 'inside',
                withoutEnlargement: true
            });

            const finalLogoBuffer = await resizedPipeline.toBuffer();
            const finalLogoMeta = await sharp(finalLogoBuffer).metadata();

            const logoLeft = Math.floor((greenBoundaryX - finalLogoMeta.width) / 2);
            const logoTop = Math.floor((height - finalLogoMeta.height) / 2);

            compositeOps.push({
                input: finalLogoBuffer,
                top: logoTop,
                left: logoLeft
            });
        } catch (e) {
            console.warn(`[ImgProc] Logo处理异常 (${filename}): ${e.message}`);
        }
    }

    // 第三层：盖上去绿后的原图原始骨架（侧脊 + 正面封面）
    compositeOps.push({
        input: data,
        raw: { width, height, channels: 4 },
        top: 0,
        left: 0
    });

    // 6. 最终输出画布 (创建一个带有黑色底部的安全托盘)
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
        .toBuffer();

    await fs.writeFile(texturePath, finalBuffer);
}

module.exports = { processBoxTexture };
