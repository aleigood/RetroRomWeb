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

// 【新增】获取全局同步状态 (包含队列信息、当前运行任务、全局日志)
router.get('/api/status/global', async (ctx) => {
    const status = scanner.getGlobalStatus();
    ctx.body = {
        runningSystem: status.runningSystem,
        // 只返回等待队列的主机名列表给前端显示
        pendingQueue: status.pendingQueue.map((t) => t.system),
        logs: status.logs,
        progress: status.progress,
        isSyncing: !!status.runningSystem
    };
});

// 【修改】请求扫描（加入队列）
router.post('/api/scan/:system', async (ctx) => {
    const system = ctx.params.system;
    const options = ctx.request.body || {};

    // 调用队列方法
    const result = await scanner.addToSyncQueue(system, options);

    if (!result.success) {
        // 如果重复点击或正在运行，返回 info，前端可以忽略
        ctx.body = { status: 'ignored', message: result.message };
    } else {
        ctx.body = { status: 'queued', message: 'Request accepted' };
    }
});

// 【修改】全局停止扫描（清空队列）
router.post('/api/stop-scan', async (ctx) => {
    scanner.stopSync();
    ctx.body = { status: 'stopped', message: 'Stopping all tasks...' };
});

router.get('/api/systems', async (ctx) => {
    return new Promise((resolve) => {
        const sql = `
            SELECT 
                s.name,
                s.fullname,
                s.abbr, 
                s.maker,
                s.release_year as year,
                s.desc,
                s.history,
                COUNT(g.id) as count
            FROM systems s
            LEFT JOIN games g ON s.name = g.system
            GROUP BY s.name 
            ORDER BY s.name COLLATE NOCASE ASC
        `;

        db.all(sql, (err, rows) => {
            if (err) {
                ctx.status = 500;
                ctx.body = { error: err.message };
            } else {
                const result = rows.map((r) => ({
                    name: r.name,
                    count: r.count,
                    fullname: r.fullname || r.name.toUpperCase(),
                    abbr: r.abbr || r.name.substring(0, 4).toUpperCase(),
                    maker: r.maker || 'Local',
                    year: r.year || '',
                    desc: r.desc || 'Detected local directory.',
                    history: r.history || r.desc || 'No details available.'
                }));
                ctx.body = result;
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
    ctx.set('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
    ctx.type = path.extname(filename);
    ctx.body = fs.createReadStream(fullPath);
});

app.use(router.routes()).use(router.allowedMethods());
app.listen(config.port, () => {
    console.log(`RetroRomWeb V13 (Queue Mode) started on http://localhost:${config.port}`);
});
