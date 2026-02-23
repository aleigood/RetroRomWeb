/**
 * scanner.js
 * 负责扫描 ROM 目录，与数据库同步，并调用 scraper 抓取元数据
 * * 修改记录：
 * 1. [Fix] 修复下载链接包含敏感参数导致文件名错误和隐私泄露的问题
 * 2. [Feat] 增加 cleanOrphanedMedia 的操作日志
 * 3. [Feat] 支持增量刷新 (incremental) 选项
 * 4. [Feat] 单游戏刷新支持强制覆盖图片 (Overwrite Mode)
 * 5. [Fix] 增加媒体文件下载异常的捕获与前端日志推送，防止队列卡死
 * 6. [Feat] 采用 VIP 快车道机制执行单游戏刷新，并增加防误删文件保护
 * 7. [Fix] 修复 ESLint 检查错误：Promise 参数命名规范问题
 * 8. [Feat] 增加 media_library 数据库死链精准清理机制，并解决跨平台路径大小写比对问题
 * 9. [Fix] 彻底修复 ESLint promise/param-names 与 n/handle-callback-err 规范问题
 */
const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const db = require('../db/database');
const scraper = require('../utils/scraper');
const fileQueue = require('../utils/queue');
const imgProcessor = require('../utils/imgProcessor'); // 引入图片处理器

const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif'];
const VIDEO_EXTS = ['.mp4', '.webm', '.mkv', '.avi'];

const ROM_EXTS = [
    '.zip',
    '.7z',
    '.iso',
    '.bin',
    '.cue',
    '.chd',
    '.cso',
    '.nes',
    '.sfc',
    '.gba',
    '.gb',
    '.gbc',
    '.md',
    '.gen',
    '.z64',
    '.n64',
    '.nds',
    '.3ds',
    '.cia',
    '.nsp',
    '.xci',
    '.wbfs',
    '.wua',
    '.cci',
    '.rvz'
];

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

const dirCache = {};

const globalStatus = {
    runningSystem: null,
    pendingQueue: [],
    isStopping: false,
    logs: [],
    progress: { current: 0, total: 0 }
};

let systemsConfig = null;

function addLog (message, systemPrefix = null) {
    const time = new Date().toLocaleTimeString();
    const prefix = systemPrefix || globalStatus.runningSystem || 'System';
    const logMsg = `[${time}] [${prefix}] ${message}`;
    globalStatus.logs.push(logMsg);
    if (globalStatus.logs.length > 200) globalStatus.logs.shift();
    console.log(logMsg);
}

function ensureMediaTable () {
    db.run('CREATE TABLE IF NOT EXISTS media_library (url TEXT PRIMARY KEY, local_path TEXT)');
}

// === 核心：添加任务到队列 ===
async function addToSyncQueue (system, options = {}) {
    if (globalStatus.runningSystem === system) return { success: false, message: '该主机正在同步中' };
    const inQueue = globalStatus.pendingQueue.find((task) => task.system === system);
    if (inQueue) return { success: false, message: '该主机已在等待队列中' };

    if (!globalStatus.runningSystem) {
        addLog('立即启动同步任务', system);
        processSystemSync(system, options).catch((err) => {
            console.error(err);
            finishCurrentSystem();
        });
    } else {
        globalStatus.pendingQueue.push({ system, options });
        addLog(`当前忙碌 (${globalStatus.runningSystem})，已加入等待队列`, system);
    }
    return { success: true };
}

// === 单游戏强制刷新 (VIP 队列版) ===
async function syncSingleGame (system, filename, options) {
    // 包装成一个任务推入 fileQueue 的 VIP 快车道
    return new Promise((resolve, reject) => {
        // 第二个参数 true 代表推入 expressQueue
        fileQueue.add(async () => {
            try {
                ensureMediaTable();
                console.log(`[Manual Sync] ${system} -> ${filename} (VIP Queue)`);

                const sysConfig = loadSystemConfig();
                const sysInfo = sysConfig[system.toLowerCase()] || {};
                const scraperId = sysInfo.scraper_id;

                // 【修复】ESLint promise/param-names，使用 resolve 不会冲突，因为作用域不同
                const oldData = await new Promise((resolve) => {
                    db.get('SELECT * FROM games WHERE system = ? AND filename = ?', [system, filename], (err, row) => {
                        if (err) console.error('[Scanner] DB Check Error:', err);
                        resolve(row || null);
                    });
                });

                // 【修复】规范处理回调错误，确保不用 err 解析 Promise
                await new Promise((resolve) => {
                    db.run('DELETE FROM games WHERE system = ? AND filename = ?', [system, filename], (err) => {
                        if (err) console.error('[Scanner] Delete Error:', err);
                        resolve();
                    });
                });

                const defaultOps = {
                    syncInfo: true,
                    syncImages: true,
                    syncVideo: false,
                    syncMarquees: true,
                    syncBoxArt: false
                };
                const syncOps = options || defaultOps;

                // 单游戏刷新时，强制关闭增量模式，并开启 overwrite (覆盖资源) 模式
                syncOps.incremental = false;
                syncOps.overwrite = true;

                await processNewGame(system, filename, oldData, syncOps, scraperId);

                // 如果在 VIP 任务执行时，全局刚好也在同步同一个主机，
                // 我们不能立刻执行清理，否则会误删全局正在下载但还没入库的图片！
                if (globalStatus.runningSystem !== system) {
                    console.log(`[Manual Sync] Cleaning orphaned media for ${system}...`);
                    await cleanOrphanedMedia(system);
                } else {
                    console.log(`[Manual Sync] ⚠️ 跳过清理冗余文件，因为全局正在同步 ${system}`);
                }

                resolve(true);
            } catch (e) {
                console.error(`[Manual Sync Error] ${e.message}`);
                reject(e);
            }
        }, true);
    });
}

// === 核心：执行系统同步 ===
async function processSystemSync (system, options) {
    ensureMediaTable();
    globalStatus.runningSystem = system;
    globalStatus.isStopping = false;
    globalStatus.progress = { current: 0, total: 0 };

    for (const key in dirCache) delete dirCache[key];
    addLog('准备开始同步...', system);

    const sysConfig = loadSystemConfig();
    const sysInfo = sysConfig[system.toLowerCase()] || {};
    const scraperId = sysInfo.scraper_id;

    // 默认 incremental: true (增量更新)
    const defaultOps = {
        syncInfo: true,
        syncImages: true,
        syncVideo: false,
        syncMarquees: true,
        syncBoxArt: false,
        incremental: true,
        overwrite: false // 批量扫描默认不覆盖现有图片，节省流量
    };
    const syncOps = options ? { ...defaultOps, ...options } : defaultOps;

    if (scraperId) addLog(`Scraper ID: ${scraperId}`, system);

    const systemDir = path.join(config.romsDir, system);
    let diskFiles = [];
    try {
        diskFiles = fs.readdirSync(systemDir).filter((f) => ROM_EXTS.includes(path.extname(f).toLowerCase()));
    } catch (e) {
        addLog(`读取目录失败: ${e.message}`, system);
        finishCurrentSystem();
        return;
    }

    const dbGames = await new Promise((resolve) => {
        db.all('SELECT * FROM games WHERE system = ?', [system], (err, rows) => {
            if (err) console.error(err);
            resolve(rows || []);
        });
    });

    const dbFilenameMap = {};
    dbGames.forEach((g) => (dbFilenameMap[g.filename] = g));

    const toAdd = diskFiles.filter((f) => !dbFilenameMap[f]);
    const toDelete = dbGames.filter((g) => !diskFiles.includes(g.filename));

    const toUpdate = dbGames
        .filter((g) => {
            if (!diskFiles.includes(g.filename)) return false;
            if (globalStatus.isStopping) return false;

            // 如果 incremental 为 false (强制刷新)，直接视为需要更新
            if (syncOps.incremental === false) {
                return true;
            }

            // --- 增量检测逻辑 ---
            const missingInfo = syncOps.syncInfo && (!g.desc || g.desc === '暂无简介');

            let missingImg = syncOps.syncImages && !g.image_path;
            if (!missingImg && syncOps.syncImages && g.image_path) {
                const fullPath = path.join(config.mediaDir, g.image_path);
                if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size === 0) missingImg = true;
            }

            let missingVid = syncOps.syncVideo && !g.video_path;
            if (!missingVid && syncOps.syncVideo && g.video_path) {
                const fullPath = path.join(config.mediaDir, g.video_path);
                if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size === 0) missingVid = true;
            }

            let missingMarquee = false;
            if (syncOps.syncMarquees) {
                const targetPath = g.marquee_path ? path.join(config.mediaDir, g.marquee_path) : '';
                if (!targetPath || !fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
                    missingMarquee = true;
                }
            }

            let missingBoxArt = false;
            if (syncOps.syncBoxArt) {
                const targetPath = g.box_texture_path ? path.join(config.mediaDir, g.box_texture_path) : '';
                if (!targetPath || !fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
                    missingBoxArt = true;
                }
            }

            return missingInfo || missingImg || missingVid || missingMarquee || missingBoxArt;
        })
        .map((g) => g.filename);

    addLog(
        `新增 ${toAdd.length}, 删除 ${toDelete.length}, 更新 ${toUpdate.length} (增量: ${syncOps.incremental})`,
        system
    );

    if (toDelete.length > 0) {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            const deleteStmt = db.prepare('DELETE FROM games WHERE id = ?');
            toDelete.forEach((game) => {
                deleteStmt.run(game.id);
            });
            deleteStmt.finalize();
            db.run('COMMIT');
        });
    }

    const taskList = Array.from(new Set([...toAdd, ...toUpdate]));

    if (taskList.length === 0) {
        addLog('文件无变化，检查冗余资源...', system);
        await cleanOrphanedMedia(system);
        finishCurrentSystem();
        return;
    }

    globalStatus.progress.total = taskList.length;
    let completedCount = 0;

    taskList.forEach((filename) => {
        // 全局任务默认推入普通队列 (isExpress 默认为 false)
        fileQueue.add(async () => {
            if (globalStatus.isStopping) {
                completedCount++;
                checkFinish(completedCount, taskList.length);
                return;
            }
            try {
                const oldData = dbFilenameMap[filename] || null;
                if (oldData) {
                    // 【修复】正确处理回调 err
                    await new Promise((resolve) => {
                        db.run('DELETE FROM games WHERE system = ? AND filename = ?', [system, filename], (err) => {
                            if (err) console.error(err);
                            resolve();
                        });
                    });
                }
                await processNewGame(system, filename, oldData, syncOps, scraperId);
                completedCount++;
                globalStatus.progress.current = completedCount;
                checkFinish(completedCount, taskList.length);
            } catch (e) {
                addLog(`处理失败: ${filename} - ${e.message}`, system);
                completedCount++;
                checkFinish(completedCount, taskList.length);
            }
        });
    });
}

function checkFinish (current, total) {
    if (current >= total) {
        addLog('同步完成，开始清理冗余资源...', globalStatus.runningSystem);
        cleanOrphanedMedia(globalStatus.runningSystem)
            .then(() => {
                addLog('资源清理完毕', globalStatus.runningSystem);
                finishCurrentSystem();
            })
            .catch((err) => {
                console.error('Cleanup error:', err);
                finishCurrentSystem();
            });
    }
}

async function cleanOrphanedMedia (system) {
    const sql =
        'SELECT image_path, video_path, marquee_path, box_texture_path, screenshot_path FROM games WHERE system = ?';
    const rows = await new Promise((resolve) => {
        db.all(sql, [system], (err, r) => {
            if (err) console.error('Clean query error:', err);
            resolve(r || []);
        });
    });

    const validPaths = new Set();
    rows.forEach((row) => {
        // 统一转化为小写存入 Set，解决跨平台大小写“误杀”问题
        if (row.image_path) validPaths.add(path.normalize(row.image_path).toLowerCase());
        if (row.video_path) validPaths.add(path.normalize(row.video_path).toLowerCase());
        if (row.marquee_path) validPaths.add(path.normalize(row.marquee_path).toLowerCase());
        if (row.box_texture_path) validPaths.add(path.normalize(row.box_texture_path).toLowerCase());
        if (row.screenshot_path) validPaths.add(path.normalize(row.screenshot_path).toLowerCase());
    });

    const folders = ['covers', 'videos', 'marquees', 'boxtextures', 'screenshots'];

    for (const folder of folders) {
        const dirPath = path.join(config.mediaDir, system, folder);
        if (!fs.existsSync(dirPath)) continue;

        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            if (file.startsWith('.')) continue;

            const fullPath = path.join(dirPath, file);
            // 比对时也将路径转为小写
            const dbStylePath = path.join(system, folder, file).toLowerCase();

            if (!validPaths.has(path.normalize(dbStylePath))) {
                try {
                    fs.unlinkSync(fullPath);
                    addLog(`🗑️ 清理冗余资源: ${folder}/${file}`, system);
                } catch (e) {
                    console.error(`删除失败: ${file}`, e.message);
                }
            }
        }
    }

    // 物理文件清理完毕后，执行数据库精确死链清理
    await cleanDeadMediaLinks(system);
}

// === 精准清理死链的函数 ===
async function cleanDeadMediaLinks (system) {
    const prefixMatch = `${system.toLowerCase()}%`;
    const sql = 'SELECT url, local_path FROM media_library WHERE LOWER(local_path) LIKE ?';

    // 【修复】n/handle-callback-err: 加入了对 err 的处理
    const rows = await new Promise((resolve) => {
        db.all(sql, [prefixMatch], (err, r) => {
            if (err) console.error('[Cleanup] Query dead links error:', err);
            resolve(r || []);
        });
    });

    let deadCount = 0;
    for (const row of rows) {
        const fullPath = path.join(config.mediaDir, row.local_path);
        if (!fs.existsSync(fullPath)) {
            try {
                // 【修复】正确处理回调 err
                await new Promise((resolve) => {
                    db.run('DELETE FROM media_library WHERE url = ?', [row.url], (err) => {
                        if (err) console.error('[Cleanup] Delete dead link error:', err);
                        resolve();
                    });
                });
                deadCount++;
            } catch (e) {}
        }
    }
    if (deadCount > 0) {
        console.log(`[Cleanup] 系统 ${system} 成功清理了 ${deadCount} 条 media_library 失效记录`);
    }
}

function finishCurrentSystem () {
    globalStatus.runningSystem = null;
    if (globalStatus.pendingQueue.length > 0 && !globalStatus.isStopping) {
        const nextTask = globalStatus.pendingQueue.shift();
        addLog(`自动启动下一个任务: ${nextTask.system}`, 'Queue');
        setTimeout(() => {
            processSystemSync(nextTask.system, nextTask.options).catch((e) => {
                console.error(e);
                finishCurrentSystem();
            });
        }, 1000);
    } else {
        if (globalStatus.isStopping) {
            addLog('同步队列已强制清空并停止', 'Global');
            globalStatus.isStopping = false;
        } else {
            addLog('所有计划任务已完成', 'Global');
        }
    }
}

function stopSync () {
    if (globalStatus.runningSystem || globalStatus.pendingQueue.length > 0) {
        globalStatus.isStopping = true;
        const pendingCount = globalStatus.pendingQueue.length;
        globalStatus.pendingQueue = [];
        fileQueue.clear();
        addLog(`中止指令生效。丢弃等待队列(${pendingCount})，正在停止当前任务...`, 'Global');
        setTimeout(() => {
            globalStatus.runningSystem = null;
            globalStatus.isStopping = false;
            addLog('已完全停止', 'Global');
        }, 500);
    }
}

function getDirFilesMap (dirPath) {
    if (dirCache[dirPath]) return dirCache[dirPath];
    const fileMap = {};
    if (fs.existsSync(dirPath)) {
        try {
            fs.readdirSync(dirPath).forEach((f) => {
                fileMap[f.toLowerCase()] = f;
            });
        } catch (e) {}
    }
    dirCache[dirPath] = fileMap;
    return fileMap;
}

function findLocalImage (system, romBasename) {
    const types = ['covers', 'miximages', 'screenshots'];
    for (const type of types) {
        const fileMap = getDirFilesMap(path.join(config.mediaDir, system, type));
        for (const ext of IMG_EXTS) {
            if (fileMap[(romBasename + ext).toLowerCase()]) {
                return path.join(system, type, fileMap[(romBasename + ext).toLowerCase()]).replace(/\\/g, '/');
            }
        }
    }
    return null;
}

function findLocalVideo (system, romBasename) {
    const fileMap = getDirFilesMap(path.join(config.mediaDir, system, 'videos'));
    for (const ext of VIDEO_EXTS) {
        if (fileMap[(romBasename + ext).toLowerCase()]) {
            return path.join(system, 'videos', fileMap[(romBasename + ext).toLowerCase()]).replace(/\\/g, '/');
        }
    }
    return null;
}

function loadSystemConfig () {
    if (systemsConfig) return systemsConfig;
    try {
        systemsConfig = fs.readJsonSync(path.join(__dirname, '../systems.json'));
    } catch (e) {
        systemsConfig = {};
    }
    return systemsConfig;
}

async function processNewGame (system, filename, oldData = null, options = {}, scraperId = null) {
    const romPath = path.join(system, filename).replace(/\\/g, '/');
    const fullPath = path.join(config.romsDir, system, filename);
    const basename = path.basename(filename, path.extname(filename));

    let imagePath = findLocalImage(system, basename);
    let videoPath = findLocalVideo(system, basename);
    let marqueePath = null;
    let boxTexturePath = null;
    let screenshotPath = null;

    if (oldData) {
        if (oldData.image_path) imagePath = oldData.image_path;
        if (oldData.video_path) videoPath = oldData.video_path;
        if (oldData.marquee_path) marqueePath = oldData.marquee_path;
        if (oldData.box_texture_path) boxTexturePath = oldData.box_texture_path;
        if (oldData.screenshot_path) screenshotPath = oldData.screenshot_path;
    }

    const gameInfo = {
        name: oldData?.name || basename,
        desc: oldData?.desc || '暂无简介',
        rating: oldData?.rating || '0',
        developer: oldData?.developer || '',
        publisher: oldData?.publisher || '',
        genre: oldData?.genre || '',
        players: oldData?.players || ''
    };

    const shouldScrape =
        options.syncInfo ||
        options.syncImages ||
        options.syncVideo ||
        options.syncMarquees ||
        options.syncBoxArt ||
        !oldData;

    if (shouldScrape) {
        addLog(`处理: ${filename}`, system);
        try {
            const scraperData = await scraper.fetchGameInfo(system, filename, fullPath, scraperId);
            if (scraperData) {
                addLog(`匹配成功: ${scraperData.name}`, system);
                if (options.syncInfo) Object.assign(gameInfo, scraperData);

                const safeName = scraperData.name.replace(/[\\/:*?"<>|]/g, '-').trim();
                const overwrite = options.overwrite === true;

                // 定义 handleDownload
                const handleDownload = async (url, folder, type) => {
                    if (!url) return null;
                    const cleanUrl = url.split('?')[0];
                    let ext = path.extname(cleanUrl).toLowerCase();
                    if (!ext || ext === '.php' || ext === '.html') {
                        if (type === 'videos') ext = '.mp4';
                        else ext = '.png';
                    }
                    const fileName = safeName + ext;
                    const dbPath = path.join(system, folder, fileName).replace(/\\/g, '/');

                    try {
                        await downloadMedia(url, system, type, fileName, overwrite);
                        return dbPath;
                    } catch (e) {
                        addLog(`❌ 下载 ${type} 失败: ${e.message}`, system);
                        return null; // 返回 null 使得数据库该字段为空，跳过此媒体
                    }
                };

                // 1. 先处理 Marquee
                if (options.syncMarquees) {
                    if (scraperData.marqueeUrl) {
                        marqueePath = await handleDownload(scraperData.marqueeUrl, 'marquees', 'marquees');
                    }
                }

                // 2. 处理其他媒体
                if (options.syncImages) {
                    if (scraperData.boxArtUrl) {
                        imagePath = await handleDownload(scraperData.boxArtUrl, 'covers', 'covers');
                    }
                    if (scraperData.screenUrl) {
                        screenshotPath = await handleDownload(scraperData.screenUrl, 'screenshots', 'screenshots');
                    }
                }

                if (options.syncVideo) {
                    if (scraperData.videoUrl) {
                        videoPath = await handleDownload(scraperData.videoUrl, 'videos', 'videos');
                    }
                }

                // 3. 最后处理 Box Texture (依赖 Marquee)
                if (options.syncBoxArt) {
                    if (scraperData.boxTextureUrl) {
                        boxTexturePath = await handleDownload(scraperData.boxTextureUrl, 'boxtextures', 'boxtextures');

                        if (boxTexturePath) {
                            const fullBoxPath = path.join(config.mediaDir, boxTexturePath);
                            const fullMarqueePath = marqueePath ? path.join(config.mediaDir, marqueePath) : null;
                            await imgProcessor.processBoxTexture(fullBoxPath, fullMarqueePath);
                        }
                    }
                }
            }
        } catch (e) {
            addLog(`抓取跳过: ${e.message}`, system);
        }
    }

    // 【修复】正确处理回调 err
    return new Promise((resolve) => {
        db.run(
            `INSERT INTO games (
                path, system, filename, name, 
                image_path, video_path, marquee_path, box_texture_path, screenshot_path,
                desc, rating, developer, publisher, genre, players
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                romPath,
                system,
                filename,
                gameInfo.name,
                imagePath,
                videoPath,
                marqueePath,
                boxTexturePath,
                screenshotPath,
                gameInfo.desc,
                gameInfo.rating,
                gameInfo.developer,
                gameInfo.publisher,
                gameInfo.genre,
                gameInfo.players
            ],
            (err) => {
                if (err) console.error('[Scanner] Insert Game Error:', err);
                resolve();
            }
        );
    });
}

// 增加 overwrite 参数
async function downloadMedia (url, system, type, filename, overwrite = false) {
    const target = path.join(config.mediaDir, system, type, filename);

    if (overwrite && fs.existsSync(target)) {
        try {
            fs.unlinkSync(target);
        } catch (e) {}
    }

    if (fs.existsSync(target)) {
        const stats = fs.statSync(target);
        if (stats.size > 0) return;
        fs.unlinkSync(target);
    }

    const existing = await new Promise((resolve) => {
        db.get('SELECT local_path FROM media_library WHERE url = ?', [url], (err, row) => {
            if (err) console.error(err);
            resolve(row);
        });
    });

    if (existing) {
        const sourcePath = path.join(config.mediaDir, existing.local_path);
        if (fs.existsSync(sourcePath)) {
            try {
                fs.ensureDirSync(path.dirname(target));
                fs.linkSync(sourcePath, target);
                addLog(`🔗 空间优化: ${filename} (HardLink)`, system);
                return;
            } catch (e) {}
        }
    }

    addLog(`⬇️ 下载 ${type}: ${filename}`, system);
    await scraper.downloadFile(url, target);

    if (fs.existsSync(target)) {
        const relPath = path.relative(config.mediaDir, target).replace(/\\/g, '/');
        db.run('INSERT OR REPLACE INTO media_library (url, local_path) VALUES (?, ?)', [url, relPath]);
    }
}

async function startScan () {
    console.log('=== 系统启动初始化 ===');
    ensureMediaTable();
    let systems = [];
    try {
        systems = fs.readdirSync(config.romsDir).filter((file) => {
            const full = path.join(config.romsDir, file);
            return (
                fs.statSync(full).isDirectory() && !file.startsWith('.') && !IGNORE_DIRS.includes(file.toLowerCase())
            );
        });
        console.log(`检测到 ${systems.length} 个主机目录`);
    } catch (e) {
        console.error('无法读取 ROM 目录:', e.message);
    }
    console.log('=== 初始化完成 ===');
}

if (require.main === module) {
    startScan();
}

module.exports = {
    startScan,
    addToSyncQueue,
    stopSync,
    getGlobalStatus: () => globalStatus,
    syncSingleGame
};
