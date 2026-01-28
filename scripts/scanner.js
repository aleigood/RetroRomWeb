/**
 * scanner.js
 * 负责扫描 ROM 目录，与数据库同步，并调用 scraper 抓取元数据
 */
const fs = require('fs-extra');
const path = require('path');
// 【清理】不再需要 xml 解析库
// const sax = require('sax');
const config = require('../config');
const db = require('../db/database');
const scraper = require('../utils/scraper');
const fileQueue = require('../utils/queue');

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
    'boxtextures', // 【新增】忽略 boxtextures 目录，防止被误认为游戏
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

// 缓存目录结构，减少IO
const dirCache = {};

// === 全局同步状态管理 ===
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
    if (globalStatus.logs.length > 200) {
        globalStatus.logs.shift();
    }
    console.log(logMsg);
}

// === 核心：添加任务到队列 (API入口) ===
async function addToSyncQueue (system, options = {}) {
    if (globalStatus.runningSystem === system) {
        return { success: false, message: '该主机正在同步中' };
    }
    const inQueue = globalStatus.pendingQueue.find((task) => task.system === system);
    if (inQueue) {
        return { success: false, message: '该主机已在等待队列中' };
    }

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

// === 新增：强制同步单个游戏 (API入口) ===
async function syncSingleGame (system, filename, options) {
    if (globalStatus.runningSystem) {
        throw new Error('Global sync is running, please wait.');
    }

    console.log(`[Manual Sync] ${system} -> ${filename}`);

    // 1. 获取系统配置（为了 Scraper ID）
    const sysConfig = loadSystemConfig();
    const sysInfo = sysConfig[system.toLowerCase()] || {};
    const scraperId = sysInfo.scraper_id;

    // 2. 查找现有数据（为了路径或备份）
    const oldData = await new Promise((resolve) => {
        db.get('SELECT * FROM games WHERE system = ? AND filename = ?', [system, filename], (err, row) => {
            // 【修复】处理错误回调，修复 ESLint 报错
            if (err) console.error('[Scanner] DB Check Error:', err);
            resolve(row || null);
        });
    });

    // 3. 删除旧记录 (必须删除，否则 processNewGame 可能会因为 UNIQUE 约束报错或跳过)
    await new Promise((resolve) => {
        db.run('DELETE FROM games WHERE system = ? AND filename = ?', [system, filename], resolve);
    });

    // 4. 强制执行抓取逻辑
    // 【修改】使用传入的 options，如果没有传则使用默认值
    // 默认不下载视频和包装图，防止单点刷新时意外下载大文件
    const defaultOps = { syncInfo: true, syncImages: true, syncVideo: false, syncMarquees: true, syncBoxArt: false };
    const syncOps = options || defaultOps;

    // oldData 传进去是为了复用可能存在的图片路径，但我们会根据 options 决定是否重新下载
    await processNewGame(system, filename, oldData, syncOps, scraperId);

    return true;
}

// === 核心：执行单个系统的同步逻辑 ===
async function processSystemSync (system, options) {
    globalStatus.runningSystem = system;
    globalStatus.isStopping = false;
    globalStatus.progress = { current: 0, total: 0 };

    for (const key in dirCache) delete dirCache[key];

    addLog('准备开始同步...', system);

    const sysConfig = loadSystemConfig();
    const sysInfo = sysConfig[system.toLowerCase()] || {};
    // 【修改】适配 systems.json 字段变更：id -> scraper_id
    const scraperId = sysInfo.scraper_id;

    // 【修改】默认选项：不下载视频和包装图
    const syncOps = options || {
        syncInfo: true,
        syncImages: true,
        syncVideo: false,
        syncMarquees: true,
        syncBoxArt: false
    };

    if (scraperId) {
        addLog(`Scraper ID: ${scraperId}`, system);
    }

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
    dbGames.forEach((g) => {
        dbFilenameMap[g.filename] = g;
    });

    const toAdd = diskFiles.filter((f) => !dbFilenameMap[f]);
    const toDelete = dbGames.filter((g) => !diskFiles.includes(g.filename));

    const toUpdate = dbGames
        .filter((g) => {
            if (!diskFiles.includes(g.filename)) return false;
            if (globalStatus.isStopping) return false;

            const missingInfo = syncOps.syncInfo && (!g.desc || g.desc === '暂无简介');

            let missingImg = syncOps.syncImages && !g.image_path;
            if (!missingImg && syncOps.syncImages && g.image_path) {
                const fullPath = path.join(config.mediaDir, g.image_path);
                if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size === 0) {
                    missingImg = true;
                }
            }

            let missingVid = syncOps.syncVideo && !g.video_path;
            if (!missingVid && syncOps.syncVideo && g.video_path) {
                const fullPath = path.join(config.mediaDir, g.video_path);
                if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size === 0) {
                    missingVid = true;
                }
            }

            let missingMarquee = false;
            if (syncOps.syncMarquees) {
                const basename = path.basename(g.filename, path.extname(g.filename));
                const targetPath = path.join(config.mediaDir, system, 'marquees', basename + '.png');
                if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
                    missingMarquee = true;
                }
            }

            // 【新增】检查 Box Texture 是否缺失
            let missingBoxArt = false;
            if (syncOps.syncBoxArt) {
                const basename = path.basename(g.filename, path.extname(g.filename));
                const targetPath = path.join(config.mediaDir, system, 'boxtextures', basename + '.png');
                if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
                    missingBoxArt = true;
                }
            }

            return missingInfo || missingImg || missingVid || missingMarquee || missingBoxArt;
        })
        .map((g) => g.filename);

    addLog(`新增 ${toAdd.length}, 删除 ${toDelete.length}, 更新 ${toUpdate.length}`, system);

    if (toDelete.length > 0) {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            const deleteStmt = db.prepare('DELETE FROM games WHERE id = ?');
            toDelete.forEach((game) => {
                const basename = path.basename(game.filename, path.extname(game.filename));
                deleteLocalImages(system, basename);
                deleteStmt.run(game.id);
            });
            deleteStmt.finalize();
            db.run('COMMIT');
        });
    }

    const taskList = Array.from(new Set([...toAdd, ...toUpdate]));

    if (taskList.length === 0) {
        addLog('没有需要处理的文件', system);
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
                    await new Promise((resolve) =>
                        db.run('DELETE FROM games WHERE system = ? AND filename = ?', [system, filename], resolve)
                    );
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
        addLog('当前主机同步完成', globalStatus.runningSystem);
        finishCurrentSystem();
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

function deleteLocalImages (system, romBasename) {
    // 【修改】添加 'boxtextures'
    const types = ['covers', 'screenshots', 'miximages', 'titles', 'videos', 'marquees', 'boxtextures'];
    types.forEach((type) => {
        [...IMG_EXTS, ...VIDEO_EXTS].forEach((ext) => {
            const p = path.join(config.mediaDir, system, type, romBasename + ext);
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
        });
    });
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

    if (
        imagePath &&
        fs.existsSync(path.join(config.mediaDir, imagePath)) &&
        fs.statSync(path.join(config.mediaDir, imagePath)).size === 0
    ) {
        imagePath = null;
    }

    if (!imagePath && oldData?.image_path && fs.existsSync(path.join(config.mediaDir, oldData.image_path))) {
        if (fs.statSync(path.join(config.mediaDir, oldData.image_path)).size > 0) {
            imagePath = oldData.image_path;
        }
    }

    if (!videoPath && oldData?.video_path && fs.existsSync(path.join(config.mediaDir, oldData.video_path))) {
        if (fs.statSync(path.join(config.mediaDir, oldData.video_path)).size > 0) {
            videoPath = oldData.video_path;
        }
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

    // 【修改】判定是否需要抓取：增加 options.syncBoxArt
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

                if (options.syncImages) {
                    if (scraperData.boxArtUrl) {
                        await downloadMedia(scraperData.boxArtUrl, system, 'covers', basename + '.png');
                        imagePath = path.join(system, 'covers', basename + '.png').replace(/\\/g, '/');
                    }
                    if (scraperData.screenUrl) {
                        await downloadMedia(scraperData.screenUrl, system, 'screenshots', basename + '.png');
                        if (!imagePath) {
                            imagePath = path.join(system, 'screenshots', basename + '.png').replace(/\\/g, '/');
                        }
                    }
                    if (!imagePath) imagePath = findLocalImage(system, basename);
                }

                if (options.syncVideo && scraperData.videoUrl) {
                    await downloadMedia(scraperData.videoUrl, system, 'videos', basename + '.mp4');
                    videoPath = path.join(system, 'videos', basename + '.mp4').replace(/\\/g, '/');
                }

                if (options.syncMarquees && scraperData.marqueeUrl) {
                    await downloadMedia(scraperData.marqueeUrl, system, 'marquees', basename + '.png');
                }

                // 【新增】下载 Box Texture
                if (options.syncBoxArt && scraperData.boxTextureUrl) {
                    await downloadMedia(scraperData.boxTextureUrl, system, 'boxtextures', basename + '.png');
                }
            }
        } catch (e) {
            addLog(`抓取跳过: ${e.message}`, system);
        }
    }

    return new Promise((resolve) => {
        db.run(
            `INSERT INTO games (path, system, filename, name, image_path, video_path, desc, rating, developer, publisher, genre, players) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                romPath,
                system,
                filename,
                gameInfo.name,
                imagePath,
                videoPath,
                gameInfo.desc,
                gameInfo.rating,
                gameInfo.developer,
                gameInfo.publisher,
                gameInfo.genre,
                gameInfo.players
            ],
            resolve
        );
    });
}

async function downloadMedia (url, system, type, filename) {
    const target = path.join(config.mediaDir, system, type, filename);
    let needDownload = true;

    if (fs.existsSync(target)) {
        const stats = fs.statSync(target);
        if (stats.size > 0) {
            needDownload = false;
        } else {
            fs.unlinkSync(target);
        }
    }

    if (needDownload) {
        addLog(`⬇️ 下载 ${type}: ${filename}`, system);
        await scraper.downloadFile(url, target);
    }
}

// 【清理】只进行基本的目录扫描日志输出，不再尝试写入 systems 表
async function startScan () {
    console.log('=== 系统启动初始化 ===');
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
    syncSingleGame // 新增导出
};
