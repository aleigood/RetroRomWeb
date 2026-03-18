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
 * 7. [Fix] 增加 media_library 数据库死链精准清理机制，并解决跨平台路径大小写比对问题
 * 8. [Feat] 向抓取器传递日志回调，用于记录未命中时的实际搜索词
 * 9. [Feat] 终极多版本优化：利用刮削返回的“游戏名”匹配同名游戏，在非覆盖模式下直接复用本地媒体数据，跳过重复下载。
 * 10.[Fix] 修复所有 ESLint n/handle-callback-err 回调错误未处理的警告。
 */
const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const db = require('../db/database');
const scraper = require('../utils/scraper');
const fileQueue = require('../utils/queue');
const imgProcessor = require('../utils/imgProcessor');

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
    '.wad',
    '.wua',
    '.cci',
    '.rvz',
    '.psv',
    '.god',
    '.d88'
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
    return new Promise((resolve, reject) => {
        fileQueue.add(async () => {
            try {
                ensureMediaTable();
                console.log(`[Manual Sync] ${system} -> ${filename} (VIP Queue)`);

                const sysConfig = loadSystemConfig();
                const sysInfo = sysConfig[system.toLowerCase()] || {};
                const scraperId = sysInfo.scraper_id;

                const oldData = await new Promise((resolve) => {
                    db.get('SELECT * FROM games WHERE system = ? AND filename = ?', [system, filename], (err, row) => {
                        if (err) console.error('[Scanner] DB Check Error:', err);
                        resolve(row || null);
                    });
                });

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

                // 单游戏刷新时，强制关闭增量模式，并开启 overwrite 模式
                syncOps.incremental = false;
                syncOps.overwrite = true;

                await processNewGame(system, filename, oldData, syncOps, scraperId);

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

    const defaultOps = {
        syncInfo: true,
        syncImages: true,
        syncVideo: false,
        syncMarquees: true,
        syncBoxArt: false,
        incremental: true,
        overwrite: false
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

            if (syncOps.incremental === false) {
                return true;
            }

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
        fileQueue.add(async () => {
            if (globalStatus.isStopping) {
                completedCount++;
                checkFinish(completedCount, taskList.length);
                return;
            }
            try {
                const oldData = dbFilenameMap[filename] || null;
                if (oldData) {
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

    await cleanDeadMediaLinks(system);
}

async function cleanDeadMediaLinks (system) {
    const prefixMatch = `${system.toLowerCase()}%`;
    const sql = 'SELECT url, local_path FROM media_library WHERE LOWER(local_path) LIKE ?';

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

    const verifyMediaPath = (relPath) => {
        if (!relPath) return null;
        const absPath = path.join(config.mediaDir, relPath);
        try {
            if (fs.existsSync(absPath) && fs.statSync(absPath).size > 0) {
                return relPath;
            }
        } catch (e) {}
        return null;
    };

    if (oldData) {
        if (oldData.image_path) imagePath = verifyMediaPath(oldData.image_path) || imagePath;
        if (oldData.video_path) videoPath = verifyMediaPath(oldData.video_path) || videoPath;
        if (oldData.marquee_path) marqueePath = verifyMediaPath(oldData.marquee_path);
        if (oldData.box_texture_path) boxTexturePath = verifyMediaPath(oldData.box_texture_path);
        if (oldData.screenshot_path) screenshotPath = verifyMediaPath(oldData.screenshot_path);
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
            const scraperData = await scraper.fetchGameInfo(system, filename, fullPath, scraperId, (msg) =>
                addLog(msg, system)
            );

            if (scraperData) {
                addLog(`匹配成功: ${scraperData.name}`, system);
                if (options.syncInfo) Object.assign(gameInfo, scraperData);

                const safeName = scraperData.name.replace(/[\\/:*?"<>|]/g, '-').trim();
                const overwrite = options.overwrite === true;

                // === 核心机制 1：基于游戏名的智能多版本复用 ===
                // 仅在【非覆盖模式】下生效：只要游戏名一致，立刻复用物理路径，并把刮削到的 URL 置空，彻底跳过下载和后续生成
                let reusedCount = 0;
                if (!overwrite) {
                    const siblingGames = await new Promise((resolve) => {
                        db.all(
                            'SELECT * FROM games WHERE system = ? AND name = ? AND filename != ?',
                            [system, gameInfo.name, filename],
                            (err, rows) => {
                                if (err) console.error('[Scanner] 查询兄弟游戏数据错误:', err);
                                resolve(rows || []);
                            }
                        );
                    });

                    for (const siblingGame of siblingGames) {
                        if (options.syncMarquees && scraperData.marqueeUrl) {
                            const valid = verifyMediaPath(siblingGame.marquee_path);
                            if (valid) {
                                marqueePath = valid;
                                reusedCount++;
                                scraperData.marqueeUrl = null;
                            }
                        }
                        if (options.syncImages && scraperData.boxArtUrl) {
                            const valid = verifyMediaPath(siblingGame.image_path);
                            if (valid) {
                                imagePath = valid;
                                reusedCount++;
                                scraperData.boxArtUrl = null;
                            }
                        }
                        if (options.syncImages && scraperData.screenUrl) {
                            const valid = verifyMediaPath(siblingGame.screenshot_path);
                            if (valid) {
                                screenshotPath = valid;
                                reusedCount++;
                                scraperData.screenUrl = null;
                            }
                        }
                        if (options.syncVideo && scraperData.videoUrl) {
                            const valid = verifyMediaPath(siblingGame.video_path);
                            if (valid) {
                                videoPath = valid;
                                reusedCount++;
                                scraperData.videoUrl = null;
                            }
                        }
                        if (options.syncBoxArt && scraperData.boxTextureUrl) {
                            const valid = verifyMediaPath(siblingGame.box_texture_path);
                            if (valid) {
                                boxTexturePath = valid;
                                reusedCount++;
                                scraperData.boxTextureUrl = null;
                            }
                        }
                    }

                    if (reusedCount > 0) {
                        addLog(`♻️ 极速秒传: 识别到同名游戏 [${gameInfo.name}]，直接复用其已有媒体`, system);
                    }
                }

                // === 核心机制 2：基于 URL 的重复下载拦截 ===
                // 仅在【非覆盖模式】下生效
                const checkMediaLibrary = async (url) => {
                    if (!url || overwrite) return null;
                    const existing = await new Promise((resolve) => {
                        db.get('SELECT local_path FROM media_library WHERE url = ?', [url], (err, row) => {
                            if (err) console.error('[Scanner] 查询媒体库历史记录错误:', err);
                            resolve(row);
                        });
                    });
                    if (existing && verifyMediaPath(existing.local_path)) {
                        return existing.local_path;
                    }
                    return null;
                };

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
                        return null;
                    }
                };

                let urlReusedCount = 0;

                // 如果经过了兄弟版本复用，URL 已经被置为 null，下面的判定将直接跳过不执行
                if (options.syncMarquees && scraperData.marqueeUrl) {
                    const cached = await checkMediaLibrary(scraperData.marqueeUrl);
                    if (cached) {
                        marqueePath = cached;
                        urlReusedCount++;
                    } else marqueePath = await handleDownload(scraperData.marqueeUrl, 'marquees', 'marquees');
                }

                if (options.syncImages) {
                    if (scraperData.boxArtUrl) {
                        const cached = await checkMediaLibrary(scraperData.boxArtUrl);
                        if (cached) {
                            imagePath = cached;
                            urlReusedCount++;
                        } else imagePath = await handleDownload(scraperData.boxArtUrl, 'covers', 'covers');
                    }
                    if (scraperData.screenUrl) {
                        const cached = await checkMediaLibrary(scraperData.screenUrl);
                        if (cached) {
                            screenshotPath = cached;
                            urlReusedCount++;
                        } else { screenshotPath = await handleDownload(scraperData.screenUrl, 'screenshots', 'screenshots'); }
                    }
                }

                if (options.syncVideo && scraperData.videoUrl) {
                    const cached = await checkMediaLibrary(scraperData.videoUrl);
                    if (cached) {
                        videoPath = cached;
                        urlReusedCount++;
                    } else videoPath = await handleDownload(scraperData.videoUrl, 'videos', 'videos');
                }

                if (options.syncBoxArt && scraperData.boxTextureUrl) {
                    const cached = await checkMediaLibrary(scraperData.boxTextureUrl);
                    if (cached) {
                        boxTexturePath = cached;
                        urlReusedCount++;
                    } else {
                        boxTexturePath = await handleDownload(scraperData.boxTextureUrl, 'boxtextures', 'boxtextures');

                        // 只有在真的下载了新图片，或者本地图片尚未处理时，才调用耗时的 sharp 生成环节
                        if (boxTexturePath) {
                            const fullBoxPath = path.join(config.mediaDir, boxTexturePath);
                            const fullMarqueePath = marqueePath ? path.join(config.mediaDir, marqueePath) : null;
                            const fullScreenshotPath = screenshotPath
                                ? path.join(config.mediaDir, screenshotPath)
                                : null;

                            const introText = gameInfo.desc && gameInfo.desc !== '暂无简介' ? gameInfo.desc : null;

                            await imgProcessor.processBoxTexture(
                                fullBoxPath,
                                fullMarqueePath,
                                fullScreenshotPath,
                                introText
                            );
                        }
                    }
                }

                if (urlReusedCount > 0) {
                    addLog(`♻️ URL缓存拦截: 复用了 ${urlReusedCount} 项已下载媒体`, system);
                }
            }
        } catch (e) {
            addLog(`抓取跳过: ${e.message}`, system);
        }
    }

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

    if (!overwrite) {
        const existing = await new Promise((resolve) => {
            db.get('SELECT local_path FROM media_library WHERE url = ?', [url], (err, row) => {
                if (err) console.error('[Scanner] 下载前查询媒体库历史错误:', err);
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
    }

    addLog(`⬇️ 下载 ${type}: ${filename}`, system);
    await scraper.downloadFile(url, target);

    if (fs.existsSync(target)) {
        const relPath = path.relative(config.mediaDir, target).replace(/\\/g, '/');
        db.run('INSERT OR REPLACE INTO media_library (url, local_path) VALUES (?, ?)', [url, relPath], (err) => {
            if (err) console.error('[Scanner] 插入媒体记录失败:', err);
        });
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
