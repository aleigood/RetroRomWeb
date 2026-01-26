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
                        core: info.core || ''
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

app.use(router.routes()).use(router.allowedMethods());
app.listen(config.port, () => {
    console.log(`RetroRomWeb V13 (Queue Mode) started on http://localhost:${config.port}`);
});
