const sharp = require('sharp');
const fs = require('fs-extra');

/**
 * 辅助函数：扫描每一行的像素，找到绿色区域的右边界
 * 逻辑：从图片宽度的 60% 处开始向左扫描，找到第一个绿色像素，即为绿色区域的“右边缘”。
 * 这样可以跳过书脊和阴影干扰，定位更准。
 */
function findGreenBoundary (data, width, height) {
    const channels = 4;
    // 扫描三行（25%, 50%, 75% 高度处），取样以提高准确度
    const scanRows = [Math.floor(height * 0.25), Math.floor(height * 0.5), Math.floor(height * 0.75)];

    const boundaries = [];
    // 假设包装盒背面（绿色）在左侧，通常不会超过整体宽度的 60%
    const startX = Math.floor(width * 0.6);

    for (const y of scanRows) {
        let foundX = 0;

        // 从右向左扫描 (startX -> 0)
        for (let x = startX; x >= 0; x--) {
            const idx = (y * width + x) * channels;

            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];

            // 绿色判定标准
            const isGreen = g > 150 && g > r + 60 && g > b + 60;

            // 一旦碰到绿色，说明跨过了书脊，到达了绿色区域的边缘
            if (isGreen) {
                foundX = x;
                break;
            }
        }
        boundaries.push(foundX);
    }

    // 排序并取中位数，剔除异常值
    boundaries.sort((a, b) => a - b);
    const medianBoundary = boundaries[1];

    // 如果边界太小（小于 5%），认为不是有效的绿幕图
    return medianBoundary < width * 0.05 ? 0 : medianBoundary;
}

/**
 * 主处理函数
 */
async function processBoxTexture (texturePath, marqueePath) {
    if (!fs.existsSync(texturePath)) return;

    // 1. 读取原图像素数据
    const { data, info } = await sharp(texturePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;
    const channels = 4;

    // 2. 计算绿色区域的宽度 (即 Logo 的容器宽度)
    const greenBoundaryX = findGreenBoundary(data, width, height);

    if (greenBoundaryX === 0) {
        return; // 未检测到绿幕，跳过
    }

    // 3. 准备渐变背景 Buffer (底色)
    const backgroundBuffer = Buffer.alloc(width * height * 4);

    // 渐变配置: 左上角亮灰 -> 右下角深黑 (#050505)
    const startColor = { r: 45, g: 45, b: 50 };
    const endColor = { r: 5, g: 5, b: 5 };

    for (let i = 0; i < data.length; i += channels) {
        // A. 生成渐变背景
        const pIndex = i / channels;
        const x = pIndex % width;
        const y = Math.floor(pIndex / width);
        const factor = (x / width + y / height) / 2;

        backgroundBuffer[i] = startColor.r + (endColor.r - startColor.r) * factor; // R
        backgroundBuffer[i + 1] = startColor.g + (endColor.g - startColor.g) * factor; // G
        backgroundBuffer[i + 2] = startColor.b + (endColor.b - startColor.b) * factor; // B
        backgroundBuffer[i + 3] = 255; // Alpha

        // B. 处理前景：将绿色变透明
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (g > 150 && g > r + 60 && g > b + 60) {
            data[i + 3] = 0; // Alpha = 0 (透明)
        }
    }

    // 4. 准备合成层
    const compositeOps = [];

    // 处理 Logo (如果有)
    if (marqueePath && fs.existsSync(marqueePath)) {
        try {
            // === 核心逻辑：计算 Logo 尺寸和位置 ===

            // 限制 Logo 最大尺寸：宽度不超过绿色区域的 80%，高度不超过整图的 80%
            const maxLogoW = Math.round(greenBoundaryX * 0.8);
            const maxLogoH = Math.round(height * 0.8);

            const logoSharp = sharp(marqueePath).resize({
                width: maxLogoW,
                height: maxLogoH,
                fit: 'inside' // 保持长宽比缩放，直到放入框内
            });

            // 获取缩放后的实际 Logo 尺寸
            const logoMeta = await logoSharp.metadata();
            const logoBuffer = await logoSharp.toBuffer();

            // 计算居中坐标
            // 水平居中：(绿色区域宽度 - Logo实际宽度) / 2
            const logoLeft = Math.floor((greenBoundaryX - logoMeta.width) / 2);
            // 垂直居中：(整图高度 - Logo实际高度) / 2
            const logoTop = Math.floor((height - logoMeta.height) / 2);

            // 将 Logo 添加到合成队列
            compositeOps.push({
                input: logoBuffer,
                top: logoTop,
                left: logoLeft
            });
        } catch (e) {
            console.warn(`[ImgProc] Logo处理异常: ${e.message}`);
        }
    }

    // 将去除了绿色的前景图放在最上层
    compositeOps.push({
        input: data,
        raw: { width, height, channels: 4 }
    });

    // 5. 执行最终合成
    // 层级顺序：渐变底色 -> Logo -> 前景框(透明部分透出Logo和底色)
    const finalBuffer = await sharp(backgroundBuffer, {
        raw: { width, height, channels: 4 }
    })
        .composite(compositeOps)
        .png()
        .toBuffer();

    // 6. 写入文件
    await fs.writeFile(texturePath, finalBuffer);
}

module.exports = { processBoxTexture };
