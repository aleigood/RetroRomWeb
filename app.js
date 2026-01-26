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

// === 1. 全局加载 systems.json ===
// 这样我们就能知道每个平台用的是什么核心
let systemsConfig = {};
try {
    systemsConfig = fs.readJsonSync(path.join(__dirname, 'systems.json'));
} catch (e) {
    console.error('Failed to load systems.json:', e);
}

// === 2. 定义启用“自动合并”的街机核心列表 ===
// 只有在这个列表里的核心，才会触发解压合并逻辑
// 你可以根据需要添加其他核心，如 mame2003_plus 等
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
const AdmZip = require('adm-zip');

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

// === 缓存目录文件列表 ===
const dirCache = {};
function getDirFilesMap (dirPath) {
    if (dirCache[dirPath]) return dirCache[dirPath];
    const fileMap = {};
    if (fs.existsSync(dirPath)) {
        try {
            const files = fs.readdirSync(dirPath);
            files.forEach((file) => {
                fileMap[file.toLowerCase()] = file;
            });
        } catch (e) {
            console.error(e);
        }
    }
    dirCache[dirPath] = fileMap;
    setTimeout(() => {
        delete dirCache[dirPath];
    }, 60000);
    return fileMap;
}

const getImageCollection = (system, romFilename) => {
    const types = ['covers', 'miximages', 'screenshots', 'titles', 'marquees'];
    const exts = ['.png', '.jpg', '.jpeg', '.gif'];
    const images = [];

    const basename = path.basename(romFilename, path.extname(romFilename));
    const lowerBasename = basename.toLowerCase();

    types.forEach((type) => {
        const typeDir = path.join(config.mediaDir, system, type);
        const fileMap = getDirFilesMap(typeDir);

        for (const ext of exts) {
            const searchKey = lowerBasename + ext;
            if (fileMap[searchKey]) {
                const realFileName = fileMap[searchKey];
                images.push({
                    type,
                    url: path.join(system, type, realFileName).replace(/\\/g, '/')
                });
                break;
            }
        }
    });
    return images;
};

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

    if (!result.success) {
        ctx.body = { status: 'ignored', message: result.message };
    } else {
        ctx.body = { status: 'queued', message: 'Request accepted' };
    }
});

router.post('/api/stop-scan', async (ctx) => {
    scanner.stopSync();
    ctx.body = { status: 'stopped', message: 'Stopping all tasks...' };
});

// 【核心修改】删除SQL查询 systems 表，改为“库存(DB) + 知识(JSON) = 最终列表”
router.get('/api/systems', async (ctx) => {
    return new Promise((resolve) => {
        // 1. 从 JSON 文件加载静态元数据
        let metadata = {};
        try {
            metadata = fs.readJsonSync(path.join(__dirname, 'systems.json'));
        } catch (e) {
            console.error('Failed to load systems.json:', e);
        }

        // 2. 从数据库只查库存数量 (group by system)
        const sql = 'SELECT system, COUNT(*) as count FROM games GROUP BY system';

        db.all(sql, (err, rows) => {
            if (err) {
                ctx.status = 500;
                ctx.body = { error: err.message };
            } else {
                // 3. 内存合并数据
                const systems = rows.map((row) => {
                    // 统一转小写匹配 key
                    const key = (row.system || '').toLowerCase();
                    const info = metadata[key] || {};

                    return {
                        name: row.system, // 文件夹名/数据库标识
                        count: row.count,
                        // 优先用 JSON 配置，没有则回退到文件夹名
                        fullname: info.fullname || row.system.toUpperCase(),
                        abbr: info.abbr || row.system.substring(0, 4).toUpperCase(),
                        maker: info.maker || 'Unknown',
                        year: info.release_year || '0000', // 给个默认值方便排序
                        desc: info.desc || 'Detected local directory.',
                        history: info.history || info.desc || 'No details available.',
                        // 【新增】读取 JSON 中的 core 字段配置
                        core: info.core || '',
                        // 【修复】补充 bios 字段，否则前端无法获取 neogeo.zip
                        bios: info.bios || ''
                    };
                });

                // 4. 内存排序：先按 Maker (A-Z)，再按 Year (Old-New)
                systems.sort((a, b) => {
                    // 厂商首字母排序 (Case-insensitive)
                    const makerCompare = a.maker.localeCompare(b.maker, undefined, { sensitivity: 'base' });
                    if (makerCompare !== 0) return makerCompare;

                    // 同厂商，按年份排序 (数字升序)
                    const yearA = parseInt(a.year) || 9999;
                    const yearB = parseInt(b.year) || 9999;
                    return yearA - yearB;
                });

                ctx.body = systems;
            }
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

    return new Promise((resolve) => {
        if (Number(all) === 1) {
            const sql = `
                SELECT name, MAX(image_path) as image_path, MAX(video_path) as video_path, MAX(releasedate) as releasedate, 
                       MAX(developer) as developer, MAX(publisher) as publisher, 
                       MAX(genre) as genre, MAX(players) as players, 
                       MAX(rating) as rating, MAX(desc) as desc,
                       COUNT(*) as version_count
                FROM games ${where} 
                GROUP BY name 
                ORDER BY name COLLATE NOCASE ASC
            `;
            db.all(sql, params, (err, rows) => {
                if (err) {
                    ctx.status = 500;
                } else {
                    ctx.body = { data: rows };
                }
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

                const sql = `
                    SELECT name, MAX(image_path) as image_path, MAX(video_path) as video_path, MAX(releasedate) as releasedate, 
                           MAX(developer) as developer, MAX(publisher) as publisher, 
                           MAX(genre) as genre, MAX(players) as players, 
                           MAX(rating) as rating, MAX(desc) as desc,
                           COUNT(*) as version_count
                    FROM games ${where} 
                    GROUP BY name 
                    ORDER BY name COLLATE NOCASE ASC 
                    LIMIT ? OFFSET ?
                `;
                db.all(sql, [...params, limit, offset], (err, rows) => {
                    if (err) {
                        ctx.status = 500;
                    } else {
                        ctx.body = { total, page: parseInt(page), pageSize: limit, data: rows };
                    }
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
                        const images = getImageCollection(system, row.filename);
                        return { ...row, gallery: images };
                    });
                    ctx.body = result;
                }
                resolve();
            }
        );
    });
});

router.get('/bios/:filename', async (ctx) => {
    const filename = ctx.params.filename;
    // 使用 config 中配置的 biosDir
    if (!config.biosDir) {
        ctx.status = 404;
        ctx.body = 'BIOS directory not configured';
        return;
    }

    const filePath = path.join(config.biosDir, filename);

    // 安全检查，防止路径遍历攻击
    if (!filePath.startsWith(path.resolve(config.biosDir))) {
        ctx.status = 403;
        return;
    }

    if (fs.existsSync(filePath)) {
        ctx.type = path.extname(filename);
        // 使用流式传输
        ctx.body = fs.createReadStream(filePath);
    } else {
        console.error(`BIOS file not found: ${filePath}`); // 在服务端控制台打印错误，方便调试
        ctx.status = 404;
        ctx.body = 'BIOS file not found';
    }
});

router.get('/api/download/:id', async (ctx) => {
    const id = ctx.params.id;
    const game = await new Promise((resolve) => {
        db.get('SELECT path, filename FROM games WHERE id = ?', [id], (err, row) => {
            if (err) {
                console.error(err);
                return resolve(null);
            }
            resolve(row);
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

    const filename = path.basename(game.filename);
    const encoded = encodeURIComponent(filename);

    // 【新增】如果请求参数包含 play=1，则不设置 Content-Disposition 为 attachment
    // 这样浏览器/模拟器可以作为媒体资源直接加载，而不是下载文件
    if (ctx.query.play && ctx.query.play === '1') {
        // 不设置 attachment，允许内联播放
        // Koa-static 或 mime 模块会自动处理 content-type
    } else {
        ctx.set('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
    }

    ctx.type = path.extname(filename);
    ctx.body = fs.createReadStream(fullPath);
});

// 【新增】用于在线游玩的专用路由，支持在 URL 中包含文件名
// 街机模拟器 (FBNeo/MAME) 必须通过文件名 (如 kof97.zip) 来识别游戏
// :filename 参数实际上在后端不使用，只为了让 URL 看起来是对的
router.get('/api/play/:id/:filename', async (ctx) => {
    const id = ctx.params.id;
    // 我们忽略传入的 :filename，直接用 ID 查数据库获取真实文件路径
    const game = await new Promise((resolve) => {
        db.get('SELECT path, filename FROM games WHERE id = ?', [id], (err, row) => {
            if (err) {
                console.error(err);
                return resolve(null);
            }
            resolve(row);
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

    // 在线播放模式，不设置 Content-Disposition attachment
    ctx.type = path.extname(game.filename);
    ctx.body = fs.createReadStream(fullPath);
});

// 【新增】根据游戏名称查找“父ROM” (逻辑：同名游戏中文件名最短的那个)
router.get('/api/find-parent', async (ctx) => {
    const { system, name } = ctx.query;
    if (!system || !name) {
        ctx.status = 400;
        return;
    }

    return new Promise((resolve) => {
        // SQL 逻辑：
        // 1. 查找所有 system 和 name 相同的游戏
        // 2. 按 filename 的长度升序排序 (最短的排前面)
        // 3. 取第 1 个
        const sql = `
            SELECT id, filename 
            FROM games 
            WHERE system = ? AND name = ? 
            ORDER BY length(filename) ASC 
            LIMIT 1
        `;

        db.get(sql, [system, name], (err, row) => {
            if (err) {
                ctx.status = 500;
                ctx.body = { error: err.message };
            } else {
                // 如果找到了，row 就是最短文件名的那个游戏
                ctx.body = row || null;
            }
            resolve();
        });
    });
});

// 【修正 V4】服务端动态合并接口：增加核心判断限制
router.get('/api/play-merged/:id/:filename', async (ctx) => {
    const id = ctx.params.id;

    // 1. 获取当前游戏
    const game = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM games WHERE id = ?', [id], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });

    if (!game) {
        ctx.status = 404;
        return;
    }

    console.log(`[Server] Request play: ${game.filename} (ID: ${id})`);
    const childPath = path.join(config.romsDir, game.path);
    const downloadName = path.basename(game.filename);

    // ============================================================
    // 【核心判断逻辑】
    // 1. 获取该游戏所属系统的配置
    const sysKey = (game.system || '').toLowerCase();
    const sysConf = systemsConfig[sysKey];
    // 2. 获取该系统的核心 (core)
    const core = sysConf ? sysConf.core : '';

    // 3. 检查是否在街机核心白名单中
    const isArcade = ARCADE_CORES.includes(core);

    if (!isArcade) {
        console.log(`[Server] Core '${core}' is not an arcade core. Skipping merge logic.`);
        // 非街机游戏，直接发送原文件 (流式传输，速度最快)
        if (fs.existsSync(childPath)) {
            ctx.type = path.extname(downloadName);
            ctx.set('Content-Disposition', `inline; filename="${encodeURIComponent(downloadName)}"`);
            ctx.body = fs.createReadStream(childPath);
            return;
        } else {
            ctx.status = 404;
            ctx.body = 'File not found';
            return;
        }
    }
    // ============================================================

    // --- 以下是街机合并逻辑 (只有 isArcade = true 才会走到这里) ---

    // 2. 查找父游戏
    const parentGame = await new Promise((resolve, reject) => {
        db.get(
            'SELECT * FROM games WHERE system = ? AND name = ? ORDER BY length(filename) ASC LIMIT 1',
            [game.system, game.name],
            (err, row) => {
                if (err) return reject(err);
                resolve(row);
            }
        );
    });

    // 准备基础 ZIP 包
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

    // 3. 合并父游戏
    if (parentGame && parentGame.id !== game.id) {
        const parentPath = path.join(config.romsDir, parentGame.path);
        if (fs.existsSync(parentPath)) {
            try {
                console.log(`[Server] Merging Parent: ${parentGame.filename}`);
                const parentZip = new AdmZip(parentPath);
                parentZip.getEntries().forEach((entry) => {
                    if (!finalZip.getEntry(entry.entryName)) {
                        finalZip.addFile(entry.entryName, entry.getData());
                    }
                });
            } catch (e) {
                console.error('[Server] Parent merge failed:', e);
            }
        }
    }

    // 4. 合并 BIOS (仅限街机)
    if (config.biosDir) {
        // 这里可以做个简单的判断，比如 only NeoGeo need bios，或者不管都尝试合并
        // 由于前面已经过滤了 ARCADE_CORES，这里合并 BIOS 是安全的
        const biosPath = path.join(config.biosDir, 'neogeo.zip');
        if (fs.existsSync(biosPath)) {
            try {
                // 可选：只为 neogeo, fba, fbneo 等系统合并 BIOS
                console.log('[Server] Merging BIOS: neogeo.zip');
                const biosZip = new AdmZip(biosPath);
                biosZip.getEntries().forEach((entry) => {
                    if (!finalZip.getEntry(entry.entryName)) {
                        finalZip.addFile(entry.entryName, entry.getData());
                    }
                });
            } catch (e) {
                console.error('[Server] BIOS merge failed:', e);
            }
        }
    }

    // 5. 发送最终文件
    const finalBuffer = finalZip.toBuffer();
    console.log(`[Server] Final package size: ${(finalBuffer.length / 1024).toFixed(2)}KB`);

    ctx.set('Content-Type', 'application/zip');
    ctx.set('Content-Disposition', `inline; filename="${encodeURIComponent(downloadName)}"`);
    ctx.body = finalBuffer;
});

app.use(router.routes()).use(router.allowedMethods());
app.listen(config.port, () => {
    console.log(`RetroRomWeb V13 (Queue Mode) started on http://localhost:${config.port}`);
});
