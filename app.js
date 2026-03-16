/**
 * app.js
 * 服务端入口文件 (Final Fixed Version)
 * 特性：
 * 1. [Fix] 移除 getImageCollection，改为直接读取数据库新字段 (适配 cleanup.js)
 * 2. [Fix] 修复 ESLint handle-callback-err 报错
 * 3. [Feat] 保留街机 ROM 自动合并逻辑
 * 4. [Feat] 接口 /api/systems 支持合并显示本地存在但尚未扫描入库的空主机目录
 * 5. [Feat] 详情页接口增加动态获取物理文件大小功能，并支持递归计算文件夹大小
 */
const Koa = require('koa');
const Router = require('koa-router');
const serve = require('koa-static');
const range = require('koa-range');
const { koaBody } = require('koa-body');
const path = require('path');
const fs = require('fs-extra');
const config = require('./config');
const db = require('./db/database');
const scanner = require('./scripts/scanner');
const AdmZip = require('adm-zip');

// === 新增：递归计算文件夹真实大小的辅助函数 ===
function getFolderSize (dirPath) {
    let totalSize = 0;
    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                totalSize += getFolderSize(filePath);
            } else {
                totalSize += stat.size;
            }
        }
    } catch (e) {
        console.error(`[API] 遍历文件夹大小失败: ${dirPath}`, e.message);
    }
    return totalSize;
}

// === 1. 全局加载 systems.json ===
let systemsConfig = {};
try {
    systemsConfig = fs.readJsonSync(path.join(__dirname, 'systems.json'));
} catch (e) {
    console.error('Failed to load systems.json:', e);
}

// === 2. 街机核心白名单 ===
const ARCADE_CORES = [
    'fbneo',
    'fbalpha2012',
    'mame2003',
    'mame2003_plus',
    'mame2010',
    'mame2015',
    'mame',
    'finalburn_neo'
];

const app = new Koa();
const router = new Router();

app.use(range);
app.use(koaBody());

app.use(
    serve(config.mediaDir, {
        hidden: false,
        defer: false,
        index: false,
        maxage: 1000 * 60 * 60 * 24
    })
);
app.use(serve(path.join(__dirname, 'public')));

// ================= API =================

router.get('/api/status/global', async (ctx) => {
    const status = scanner.getGlobalStatus();
    ctx.body = {
        runningSystem: status.runningSystem,
        pendingQueue: status.pendingQueue.map((t) => t.system),
        logs: status.logs,
        progress: status.progress,
        isSyncing: !!status.runningSystem
    };
});

router.post('/api/scan/:system', async (ctx) => {
    const system = ctx.params.system;
    const options = ctx.request.body || {};
    const result = await scanner.addToSyncQueue(system, options);
    ctx.body = result.success
        ? { status: 'queued', message: 'Request accepted' }
        : { status: 'ignored', message: result.message };
});

router.post('/api/scan-single', async (ctx) => {
    const { system, filename, options } = ctx.request.body;
    if (!system || !filename) {
        ctx.status = 400;
        ctx.body = { error: 'Missing system or filename' };
        return;
    }
    try {
        await scanner.syncSingleGame(system, filename, options);
        ctx.body = { status: 'ok' };
    } catch (e) {
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});

router.post('/api/stop-scan', async (ctx) => {
    scanner.stopSync();
    ctx.body = { status: 'stopped', message: 'Stopping all tasks...' };
});

router.get('/api/systems', async (ctx) => {
    let metadata = {};
    try {
        metadata = await fs.readJson(path.join(__dirname, 'systems.json'));
    } catch (e) {}

    const localDirs = [];
    try {
        if (fs.existsSync(config.romsDir)) {
            const dirs = await fs.readdir(config.romsDir);
            const IGNORE_DIRS = [
                'media',
                'images',
                'covers',
                'screenshots',
                'titles',
                'wheel',
                'marquees',
                'boxart',
                'boxtextures',
                'marquee',
                'video',
                'videos',
                'bios',
                'cheats',
                'saves',
                'states',
                'downloaded_images',
                'manuals',
                'system',
                'tmp',
                'temp',
                'logs'
            ];

            for (const d of dirs) {
                const fullPath = path.join(config.romsDir, d);
                const stat = await fs.stat(fullPath);
                if (stat.isDirectory() && !d.startsWith('.') && !IGNORE_DIRS.includes(d.toLowerCase())) {
                    localDirs.push(d);
                }
            }
        }
    } catch (e) {
        console.error('[API] 读取本地 ROM 目录失败:', e.message);
    }

    return new Promise((resolve, reject) => {
        const sql = 'SELECT system, COUNT(*) as count FROM games GROUP BY system';
        db.all(sql, (err, rows) => {
            if (err) {
                ctx.status = 500;
                ctx.body = { error: err.message };
                resolve();
                return;
            }

            // === 新增：幽灵主机（目录已被删除或重命名）自动清理逻辑 ===
            const ghostSystems = rows.filter((r) => !localDirs.includes(r.system));
            if (ghostSystems.length > 0) {
                ghostSystems.forEach((ghost) => {
                    // 异步从数据库中彻底删除失效主机的所有游戏记录
                    db.run('DELETE FROM games WHERE system = ?', [ghost.system], (err) => {
                        if (!err) console.log(`[API] 目录已被移除或重命名，自动清理数据库失效记录: ${ghost.system}`);
                    });
                });
            }

            // 从当前结果中剔除幽灵主机，确保前端不再显示
            const validRows = rows.filter((r) => localDirs.includes(r.system));

            // 将本地真实存在、但数据库中还没有记录的新目录（或改名后的目录）补充进列表
            const existingSystems = validRows.map((r) => r.system);
            localDirs.forEach((dir) => {
                if (!existingSystems.includes(dir)) {
                    validRows.push({ system: dir, count: 0 });
                }
            });

            const systems = validRows.map((row) => {
                const key = (row.system || '').toLowerCase();
                const info = metadata[key] || {};
                const sysObj = {
                    name: row.system,
                    count: row.count,
                    fullname: info.fullname || row.system.toUpperCase(),
                    abbr: info.abbr || row.system.substring(0, 4).toUpperCase(),
                    maker: info.maker || 'Unknown',
                    year: info.release_year || '0000',
                    desc: info.desc || 'Detected local directory.',
                    history: info.history || info.desc || 'No details available.',
                    ejs_core: info.ejs_core || '',
                    bios: info.bios || '',
                    cover_crop: info.cover_crop || 0 // 👈 新增：将 cover_crop 字段下发给前端
                };
                Object.keys(info).forEach((k) => {
                    if (k.startsWith('ejs_') && k !== 'ejs_core') sysObj[k] = info[k];
                });
                return sysObj;
            });

            systems.sort((a, b) => {
                const makerCompare = a.maker.localeCompare(b.maker, undefined, { sensitivity: 'base' });
                if (makerCompare !== 0) return makerCompare;
                return (parseInt(a.year) || 9999) - (parseInt(b.year) || 9999);
            });

            ctx.body = systems;
            resolve();
        });
    });
});

router.get('/api/games', async (ctx) => {
    const { system, page = 1, pageSize = 24, keyword = '', all = 0 } = ctx.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (system) {
        where += ' AND system = ?';
        params.push(system);
    }
    if (keyword) {
        where += ' AND (name LIKE ? OR filename LIKE ?)';
        params.push(`%${keyword}%`, `%${keyword}%`);
    }

    const fields = `
        name, 
        GROUP_CONCAT(filename) as filename,
        MAX(image_path) as image_path, 
        MAX(video_path) as video_path,
        MAX(marquee_path) as marquee_path,
        MAX(box_texture_path) as box_texture_path,
        MAX(screenshot_path) as screenshot_path,
        MAX(releasedate) as releasedate, 
        MAX(developer) as developer, 
        MAX(publisher) as publisher, 
        MAX(genre) as genre, 
        MAX(players) as players, 
        MAX(rating) as rating, 
        MAX(desc) as desc,
        COUNT(*) as version_count
    `;

    return new Promise((resolve) => {
        if (Number(all) === 1) {
            const sql = `SELECT ${fields} FROM games ${where} GROUP BY name ORDER BY name COLLATE NOCASE ASC`;
            db.all(sql, params, (err, rows) => {
                if (err) ctx.status = 500;
                else ctx.body = { data: rows };
                resolve();
            });
        } else {
            const limit = parseInt(pageSize);
            const offset = (parseInt(page) - 1) * limit;

            db.get(`SELECT count(DISTINCT name) as total FROM games ${where}`, params, (err, row) => {
                if (err) {
                    ctx.status = 500;
                    return resolve();
                }
                const total = row.total;

                const sql = `SELECT ${fields} FROM games ${where} GROUP BY name ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?`;
                db.all(sql, [...params, limit, offset], (err, rows) => {
                    if (err) ctx.status = 500;
                    else ctx.body = { total, page: parseInt(page), pageSize: limit, data: rows };
                    resolve();
                });
            });
        }
    });
});

router.get('/api/game-versions', async (ctx) => {
    const { system, name } = ctx.query;
    if (!system || !name) {
        ctx.status = 400;
        return;
    }

    return new Promise((resolve) => {
        db.all(
            'SELECT * FROM games WHERE system = ? AND name = ? ORDER BY filename ASC',
            [system, name],
            (err, rows) => {
                if (err) {
                    ctx.status = 500;
                    ctx.body = { error: err.message };
                } else {
                    const result = rows.map((row) => {
                        const gallery = [];
                        const fixPath = (p) => (p ? p.replace(/\\/g, '/') : null);

                        if (row.image_path) gallery.push({ type: 'covers', url: fixPath(row.image_path) });
                        if (row.box_texture_path) {
                            gallery.push({ type: 'boxtextures', url: fixPath(row.box_texture_path) });
                        }
                        if (row.screenshot_path) {
                            gallery.push({ type: 'screenshots', url: fixPath(row.screenshot_path) });
                        }
                        if (row.marquee_path) gallery.push({ type: 'marquees', url: fixPath(row.marquee_path) });

                        // 【修改】实时获取硬盘中的文件大小，增加对文件夹的递归判断
                        let sizeStr = '';
                        let isDir = false;
                        if (row.path) {
                            const fullPath = path.join(config.romsDir, row.path);
                            try {
                                if (fs.existsSync(fullPath)) {
                                    const stat = fs.statSync(fullPath);
                                    isDir = stat.isDirectory();

                                    // 如果是目录则递归获取大小，否则取单文件大小
                                    const size = isDir ? getFolderSize(fullPath) : stat.size;

                                    if (size > 1073741824) sizeStr = (size / 1073741824).toFixed(2) + ' GB';
                                    else if (size > 1048576) sizeStr = (size / 1048576).toFixed(2) + ' MB';
                                    else if (size > 1024) sizeStr = (size / 1024).toFixed(2) + ' KB';
                                    else sizeStr = size + ' B';
                                }
                            } catch (e) {
                                console.error('[API] 获取文件大小失败:', e.message);
                            }
                        }

                        // 将 isDirectory 属性传递给前端
                        return { ...row, gallery, fileSizeStr: sizeStr, isDirectory: isDir };
                    });
                    ctx.body = result;
                }
                resolve();
            }
        );
    });
});

router.get('/bios/:filename', async (ctx) => {
    if (!config.biosDir) {
        ctx.status = 404;
        return;
    }
    const filePath = path.join(config.biosDir, ctx.params.filename);
    if (!filePath.startsWith(path.resolve(config.biosDir)) || !fs.existsSync(filePath)) {
        ctx.status = 404;
        return;
    }
    ctx.body = fs.createReadStream(filePath);
});

router.get('/api/download/:id', async (ctx) => {
    const id = ctx.params.id;
    const game = await new Promise((resolve) => {
        db.get('SELECT path, filename FROM games WHERE id = ?', [id], (err, row) => {
            if (err) console.error(err);
            resolve(row || null);
        });
    });
    if (!game) {
        ctx.status = 404;
        return;
    }

    const fullPath = path.join(config.romsDir, game.path);
    if (!fs.existsSync(fullPath)) {
        ctx.status = 404;
        ctx.body = 'File not found';
        return;
    }

    const stats = fs.statSync(fullPath);

    // 如果恶意绕过前端调用下载接口且目标是文件夹，则直接拦截
    if (stats.isDirectory()) {
        ctx.status = 400;
        ctx.body = 'Cannot download a directory directly.';
        return;
    }

    ctx.set('Content-Length', stats.size);
    ctx.set('Last-Modified', stats.mtime.toUTCString());

    const filename = path.basename(game.filename);
    const encoded = encodeURIComponent(filename);

    if (ctx.query.play !== '1') {
        ctx.set('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
    }

    ctx.body = fs.createReadStream(fullPath);
});

router.get('/api/play/:id/:filename', async (ctx) => {
    const id = ctx.params.id;
    const game = await new Promise((resolve) => {
        db.get('SELECT path, filename FROM games WHERE id = ?', [id], (err, row) => {
            if (err) console.error(err);
            resolve(row || null);
        });
    });

    if (!game) {
        ctx.status = 404;
        return;
    }
    const fullPath = path.join(config.romsDir, game.path);
    if (!fs.existsSync(fullPath)) {
        ctx.status = 404;
        ctx.body = 'File not found';
        return;
    }

    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
        ctx.status = 400;
        ctx.body = 'Cannot stream a directory.';
        return;
    }

    ctx.set('Content-Length', stats.size);
    ctx.set('Accept-Ranges', 'bytes');
    ctx.set('Last-Modified', stats.mtime.toUTCString());

    ctx.type = path.extname(game.filename);
    ctx.body = fs.createReadStream(fullPath);
});

router.get('/api/find-parent', async (ctx) => {
    const { system, name } = ctx.query;
    if (!system || !name) {
        ctx.status = 400;
        return;
    }
    return new Promise((resolve) => {
        const sql =
            'SELECT id, filename FROM games WHERE system = ? AND name = ? ORDER BY length(filename) ASC LIMIT 1';
        db.get(sql, [system, name], (err, row) => {
            if (err) {
                ctx.status = 500;
                ctx.body = { error: err.message };
            } else ctx.body = row || null;
            resolve();
        });
    });
});

router.get('/api/play-merged/:id/:filename', async (ctx) => {
    const id = ctx.params.id;
    const game = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM games WHERE id = ?', [id], (err, row) => (err ? reject(err) : resolve(row)));
    });
    if (!game) {
        ctx.status = 404;
        return;
    }

    console.log(`[Server] Request play: ${game.filename} (ID: ${id})`);
    const childPath = path.join(config.romsDir, game.path);
    const downloadName = path.basename(game.filename);

    const sysKey = (game.system || '').toLowerCase();
    const sysConf = systemsConfig[sysKey];
    const core = sysConf ? sysConf.ejs_core : '';
    const isArcade = ARCADE_CORES.includes(core);

    if (!isArcade) {
        if (fs.existsSync(childPath)) {
            if (fs.statSync(childPath).isDirectory()) {
                ctx.status = 400;
                ctx.body = 'Cannot stream a directory.';
                return;
            }
            ctx.type = path.extname(downloadName);
            ctx.set('Content-Disposition', `inline; filename="${encodeURIComponent(downloadName)}"`);
            ctx.body = fs.createReadStream(childPath);
        } else {
            ctx.status = 404;
            ctx.body = 'File not found';
        }
        return;
    }

    const parentGame = await new Promise((resolve) => {
        db.get(
            'SELECT * FROM games WHERE system = ? AND name = ? ORDER BY length(filename) ASC LIMIT 1',
            [game.system, game.name],
            (err, row) => {
                if (err) {
                    console.error('Find parent game error:', err);
                    return resolve(null);
                }
                resolve(row);
            }
        );
    });

    let finalZip = null;
    if (fs.existsSync(childPath)) {
        try {
            finalZip = new AdmZip(childPath);
        } catch (e) {
            console.error('[Server] Failed to load child zip:', e);
            ctx.status = 500;
            return;
        }
    } else {
        ctx.status = 404;
        ctx.body = 'Game file not found';
        return;
    }

    if (parentGame && parentGame.id !== game.id) {
        const parentPath = path.join(config.romsDir, parentGame.path);
        if (fs.existsSync(parentPath)) {
            try {
                console.log(`[Server] Merging Parent: ${parentGame.filename}`);
                const parentZip = new AdmZip(parentPath);
                parentZip.getEntries().forEach((entry) => {
                    if (!finalZip.getEntry(entry.entryName)) finalZip.addFile(entry.entryName, entry.getData());
                });
            } catch (e) {
                console.error('[Server] Parent merge failed:', e);
            }
        }
    }

    if (config.biosDir && sysConf && sysConf.bios) {
        const biosPath = path.join(config.biosDir, sysConf.bios);
        if (fs.existsSync(biosPath)) {
            try {
                console.log(`[Server] Merging BIOS for ${sysKey}: ${sysConf.bios}`);
                const biosZip = new AdmZip(biosPath);
                biosZip.getEntries().forEach((entry) => {
                    if (!finalZip.getEntry(entry.entryName)) finalZip.addFile(entry.entryName, entry.getData());
                });
            } catch (e) {
                console.error(`[Server] BIOS merge failed (${sysConf.bios}):`, e);
            }
        }
    }

    const finalBuffer = finalZip.toBuffer();
    console.log(`[Server] Final package size: ${(finalBuffer.length / 1024).toFixed(2)}KB`);

    ctx.set('Content-Type', 'application/zip');
    ctx.set('Content-Disposition', `inline; filename="${encodeURIComponent(downloadName)}"`);
    ctx.body = finalBuffer;
});

app.use(router.routes()).use(router.allowedMethods());
const server = app.listen(config.port, () => {
    console.log(`RetroRomWeb V15 (Fixed DB Mode) started on http://localhost:${config.port}`);
});

server.setTimeout(0);
server.keepAliveTimeout = 60000 * 60;
server.headersTimeout = 60000 * 65;
