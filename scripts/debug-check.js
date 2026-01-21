const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const config = require('../config');
const db = require('../db/database');

// === 测试目标 ===
const TEST_GAME_FILENAME = '1 Across 2 Down (Disk 1).zip';

async function runDebug () {
    console.log('=== RetroRomWeb 深度诊断工具 v2.0 ===');

    // 1. 从数据库获取记录
    db.get('SELECT * FROM games WHERE filename = ?', [TEST_GAME_FILENAME], (err, row) => {
        if (err || !row) {
            console.error(`[❌] 数据库里找不到游戏: ${TEST_GAME_FILENAME}`);
            return;
        }

        console.log('[1] 数据库记录:');
        console.log(`    - 游戏名称: ${row.name}`);
        console.log(`    - 图片路径: ${row.image_path} (这是相对路径)`);

        if (!row.image_path) {
            console.error('[❌] 数据库中该游戏的图片路径为空！');
            return;
        }

        // 2. 检查物理文件
        const fullPath = path.join(config.imagesDir, row.image_path);
        console.log('\n[2] 检查物理文件:');
        console.log(`    - 完整路径: ${fullPath}`);

        if (fs.existsSync(fullPath)) {
            const stats = fs.statSync(fullPath);
            console.log('    - ✅ 文件存在');
            console.log(`    - 大小: ${(stats.size / 1024).toFixed(2)} KB`);
            console.log(`    - 权限: ${stats.mode}`);
            console.log(`    - 拥有者: UID ${stats.uid} / GID ${stats.gid}`);

            if (stats.size === 0) {
                console.warn('    - ⚠️ 警告: 文件大小为 0，这可能是一张坏图！');
            }
        } else {
            console.error('    - ❌ 严重错误: 数据库指向了该文件，但硬盘上找不到它！');
            console.log('      可能原因: 扫描后文件被移动了，或者 config.imagesDir 配置有误。');
            return;
        }

        // 3. 模拟 HTTP 请求 (测试服务器配置和 URL 编码)
        // 构造浏览器会发出的请求 (进行 URL 编码)
        const encodedPath = '/' + row.image_path.split('/').map(encodeURIComponent).join('/');
        const testUrl = `http://localhost:${config.port}${encodedPath}`;

        console.log('\n[3] 模拟 HTTP 请求:');
        console.log(`    - 请求地址: ${testUrl}`);

        http.get(testUrl, (res) => {
            const { statusCode } = res;
            console.log(`    - 服务器响应代码: ${statusCode}`);
            console.log(`    - Content-Type: ${res.headers['content-type']}`);
            console.log(`    - Content-Length: ${res.headers['content-length']}`);

            if (statusCode === 200) {
                console.log('\n✅ [结论] 服务器工作正常！');
                console.log('    如果手机上还是看不到图，可能是：');
                console.log('    1. 手机浏览器缓存了旧代码 (请尝试清除缓存或用无痕模式)');
                console.log('    2. 网络问题 (防火墙端口虽然开了，但可能运营商有拦截?)');
            } else if (statusCode === 404) {
                console.log('\n❌ [结论] 服务器返回 404 Not Found。');
                console.log('    这说明 Koa 静态资源配置有问题，或者路径映射不对。');
            } else {
                console.log(`\n⚠️ [结论] 服务器返回异常代码 ${statusCode}。`);
            }
            res.resume(); // 消耗响应流
        }).on('error', (e) => {
            console.error(`    - ❌ 请求失败: ${e.message}`);
            console.log('    - 请确保服务器 (npm start) 正在运行！');
        });
    });
}

runDebug();
