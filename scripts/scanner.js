const fs = require('fs-extra');
const path = require('path');
const sax = require('sax'); // 【恢复】恢复 sax 引用，用于解析 xml
const config = require('../config');
const db = require('../db/database');
const scraper = require('../utils/scraper');
const fileQueue = require('../utils/queue'); // 引用文件级任务队列

const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif'];
const VIDEO_EXTS = ['.mp4', '.webm', '.mkv', '.avi'];

// 【合并】包含原有的所有格式以及新增的格式
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

// === 全局同步状态管理 (新特性) ===
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
    // 防重复检查
    if (globalStatus.runningSystem === system) {
        return { success: false, message: '该主机正在同步中' };
    }
    const inQueue = globalStatus.pendingQueue.find((task) => task.system === system);
    if (inQueue) {
        return { success: false, message: '该主机已在等待队列中' };
    }

    // 加入队列逻辑
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

// === 核心：执行单个系统的同步逻辑 ===
async function processSystemSync (system, options) {
    globalStatus.runningSystem = system;
    globalStatus.isStopping = false;
    globalStatus.progress = { current: 0, total: 0 };

    // 每次开始新任务时，清空之前的目录缓存
    for (const key in dirCache) delete dirCache[key];

    addLog('准备开始同步...', system);

    const sysConfig = loadSystemConfig();
    const sysInfo = sysConfig[system.toLowerCase()] || {};
    const scraperId = sysInfo.id;
    const syncOps = options || { syncInfo: true, syncImages: true, syncVideo: true, syncMarquees: true };

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

    // 【修改】优化更新检测逻辑，增加对物理文件是否存在的检查
    const toUpdate = dbGames
        .filter((g) => {
            if (!diskFiles.includes(g.filename)) return false;
            if (globalStatus.isStopping) return false;

            const missingInfo = syncOps.syncInfo && (!g.desc || g.desc === '暂无简介');

            // 检查封面：如果DB没有路径，或者DB有路径但文件不存在，都算缺失
            let missingImg = syncOps.syncImages && !g.image_path;
            if (!missingImg && syncOps.syncImages && g.image_path) {
                const fullPath = path.join(config.mediaDir, g.image_path);
                if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size === 0) {
                    missingImg = true;
                }
            }

            // 检查视频：如果DB没有路径，或者DB有路径但文件不存在，都算缺失
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
                // 检查文件大小，避免空文件误判
                if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
                    missingMarquee = true;
                }
            }
            return missingInfo || missingImg || missingVid || missingMarquee;
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
                // 如果是更新操作，且旧数据存在，我们在 processNewGame 里会处理
                // 这里不需要删除旧数据，因为 processNewGame 会执行 INSERT，
                // 我们应该在这里做区分，或者让 processNewGame 支持 UPDATE。
                // 但目前的逻辑是先 DELETE 再 INSERT，为了保持兼容性，我们维持原状：
                // 如果是 toUpdate 列表里的，先删掉旧记录，再重新插入。
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
        fileQueue.clear(); // 清空文件级队列
        addLog(`中止指令生效。丢弃等待队列(${pendingCount})，正在停止当前任务...`, 'Global');
        setTimeout(() => {
            globalStatus.runningSystem = null;
            globalStatus.isStopping = false;
            addLog('已完全停止', 'Global');
        }, 500);
    }
}

// === 辅助函数 (完整保留) ===

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
    const types = ['covers', 'screenshots', 'miximages', 'titles', 'videos', 'marquees'];
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

    // 检查旧数据图片是否存在且非空
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

    const shouldScrape =
        options.syncInfo || options.syncImages || options.syncVideo || options.syncMarquees || !oldData;

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
                        // 如果封面下载失败，使用截图补位
                        if (!imagePath) {
                            imagePath = path.join(system, 'screenshots', basename + '.png').replace(/\\/g, '/');
                        }
                    }
                    // 如果以上都失败了，再尝试本地查找一次
                    if (!imagePath) imagePath = findLocalImage(system, basename);
                }

                if (options.syncVideo && scraperData.videoUrl) {
                    await downloadMedia(scraperData.videoUrl, system, 'videos', basename + '.mp4');
                    videoPath = path.join(system, 'videos', basename + '.mp4').replace(/\\/g, '/');
                }

                if (options.syncMarquees && scraperData.marqueeUrl) {
                    await downloadMedia(scraperData.marqueeUrl, system, 'marquees', basename + '.png');
                }
            }
        } catch (e) {
            addLog(`抓取跳过: ${e.message}`, system);
        }
    }

    // 确保最终写入数据库前，路径是有效的字符串
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

// 【关键修改】检查文件是否存在且大小不为0，否则下载
async function downloadMedia (url, system, type, filename) {
    const target = path.join(config.mediaDir, system, type, filename);
    let needDownload = true;

    if (fs.existsSync(target)) {
        const stats = fs.statSync(target);
        if (stats.size > 0) {
            needDownload = false;
        } else {
            fs.unlinkSync(target); // 删掉空文件
        }
    }

    if (needDownload) {
        addLog(`⬇️ 下载 ${type}: ${filename}`, system); // 显示下载日志
        await scraper.downloadFile(url, target);
    }
}

async function syncHostList () {
    console.log('正在同步主机列表...');
    let diskDirs = [];
    try {
        const files = fs.readdirSync(config.romsDir);
        diskDirs = files.filter((file) => {
            const fullPath = path.join(config.romsDir, file);
            return (
                fs.statSync(fullPath).isDirectory() &&
                !file.startsWith('.') &&
                !IGNORE_DIRS.includes(file.toLowerCase())
            );
        });
    } catch (e) {
        return;
    }

    const metadata = loadSystemConfig();

    return new Promise((resolve) => {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            if (diskDirs.length > 0) {
                const placeholders = diskDirs.map(() => '?').join(',');
                db.run(`DELETE FROM systems WHERE name NOT IN (${placeholders})`, diskDirs);
            } else {
                db.run('DELETE FROM systems');
            }

            const stmt = db.prepare(
                'INSERT OR REPLACE INTO systems (name, fullname, abbr, maker, release_year, desc, history) VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            diskDirs.forEach((dir) => {
                const key = dir.toLowerCase();
                const info = metadata[key] || {};
                stmt.run(
                    dir,
                    info.fullname || dir.toUpperCase(),
                    info.abbr || dir.substring(0, 4).toUpperCase(),
                    info.maker || 'Unknown',
                    info.release_year || '',
                    info.desc || 'Local Directory',
                    info.history || ''
                );
            });
            stmt.finalize();
            db.run('COMMIT', resolve);
        });
    });
}

// 【恢复】完整的 gamelist.xml 导入逻辑，并规范化格式
function importGamelistXml (system) {
    return new Promise((resolve) => {
        const xmlPath = path.join(config.romsDir, system, 'gamelist.xml');
        if (!fs.existsSync(xmlPath)) return resolve();

        console.log(`[${system}] 正在导入 XML 数据...`);
        const parser = sax.createStream(false, { trim: true, lowercase: true });
        let currentGame = null;
        let currentTag = null;
        let gamesBatch = [];

        const flush = () => {
            if (gamesBatch.length === 0) return;
            db.serialize(() => {
                db.run('BEGIN TRANSACTION');
                const stmt = db.prepare(`INSERT OR REPLACE INTO games 
                    (path, system, filename, name, image_path, video_path, desc, rating, releasedate, developer, publisher, genre, players) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                gamesBatch.forEach((g) =>
                    stmt.run(
                        g.path,
                        g.system,
                        g.filename,
                        g.name,
                        g.image_path,
                        g.video_path,
                        g.desc,
                        g.rating,
                        g.releasedate,
                        g.developer,
                        g.publisher,
                        g.genre,
                        g.players
                    )
                );
                stmt.finalize();
                db.run('COMMIT');
            });
            gamesBatch = [];
        };

        parser.on('opentag', (node) => {
            currentTag = node.name;
            if (node.name === 'game') currentGame = { system };
        });

        parser.on('text', (text) => {
            if (currentGame && currentTag) {
                if (!currentGame[currentTag]) currentGame[currentTag] = '';
                currentGame[currentTag] += text;
            }
        });

        parser.on('closetag', (tagName) => {
            if (tagName === 'game' && currentGame) {
                let romPath = currentGame.path || '';
                if (romPath.startsWith('./')) romPath = romPath.substring(2);
                const basename = path.basename(romPath, path.extname(romPath));

                let imgPath = currentGame.image || '';
                if (imgPath.startsWith('./')) imgPath = imgPath.substring(2);
                if (imgPath) imgPath = path.join(system, imgPath).replace(/\\/g, '/');
                if (!imgPath) imgPath = findLocalImage(system, basename);

                let videoPath = currentGame.video || '';
                if (videoPath.startsWith('./')) videoPath = videoPath.substring(2);
                if (videoPath) videoPath = path.join(system, videoPath).replace(/\\/g, '/');
                if (!videoPath) videoPath = findLocalVideo(system, basename);

                const gameData = {
                    path: path.join(system, romPath).replace(/\\/g, '/'),
                    system,
                    filename: romPath,
                    name: currentGame.name || basename,
                    image_path: imgPath,
                    video_path: videoPath,
                    desc: currentGame.desc || '',
                    rating: currentGame.rating || '0',
                    releasedate: currentGame.releasedate || '',
                    developer: currentGame.developer || '',
                    publisher: currentGame.publisher || '',
                    genre: currentGame.genre || '',
                    players: currentGame.players || ''
                };
                gamesBatch.push(gameData);
                if (gamesBatch.length >= 500) flush();
                currentGame = null;
            }
        });

        parser.on('end', () => {
            flush();
            resolve();
        });

        parser.write('<root>');
        const fsStream = fs.createReadStream(xmlPath);
        fsStream.on('data', (c) => parser.write(c));
        fsStream.on('end', () => {
            parser.write('</root>');
            parser.end();
        });
    });
}

async function startScan () {
    console.log('=== 系统启动初始化 ===');
    await syncHostList();
    const systems = fs.readdirSync(config.romsDir).filter((file) => {
        const full = path.join(config.romsDir, file);
        return fs.statSync(full).isDirectory() && !file.startsWith('.') && !IGNORE_DIRS.includes(file.toLowerCase());
    });

    // 【功能保留】启动时尝试导入本地 XML
    for (const sys of systems) {
        await importGamelistXml(sys);
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
    importGamelistXml,
    getGlobalStatus: () => globalStatus
};
