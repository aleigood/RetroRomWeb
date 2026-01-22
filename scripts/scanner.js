/*
type: uploaded file
fileName: 新建文件夹/scripts/scanner.js
*/
const fs = require('fs-extra');
const path = require('path');
const sax = require('sax');
const config = require('../config');
const db = require('../db/database');
const scraper = require('../utils/scraper');
const queue = require('../utils/queue');

const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif'];
const ROM_EXTS = [
    '.zip',
    '.7z',
    '.iso',
    '.bin',
    '.nes',
    '.sfc',
    '.gba',
    '.gb',
    '.md',
    '.z64',
    '.nds',
    '.3ds',
    '.cia',
    '.nsp',
    '.xci'
];

const IGNORE_DIRS = [
    'media',
    'images',
    'covers',
    'screenshots',
    'titles',
    'wheel',
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

const dirCache = {};
const systemStates = {};

function getSystemStatus (system) {
    if (!systemStates[system]) {
        systemStates[system] = { syncing: false, logs: [], progress: { current: 0, total: 0 } };
    }
    return systemStates[system];
}

function addLog (system, message) {
    const state = getSystemStatus(system);
    const time = new Date().toLocaleTimeString();
    state.logs.push(`[${time}] ${message}`);
    if (state.logs.length > 100) state.logs.shift();
    console.log(`[${system}] ${message}`);
}

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
            console.warn(`无法读取目录: ${dirPath}`);
        }
    }
    dirCache[dirPath] = fileMap;
    return fileMap;
}

function findLocalImage (system, romBasename) {
    const types = ['covers', 'miximages', 'screenshots'];
    for (const type of types) {
        const typeDir = path.join(config.imagesDir, system, type);
        const fileMap = getDirFilesMap(typeDir);
        for (const ext of IMG_EXTS) {
            const searchKey = (romBasename + ext).toLowerCase();
            if (fileMap[searchKey]) {
                return path.join(system, type, fileMap[searchKey]).replace(/\\/g, '/');
            }
        }
    }
    return null;
}

function deleteLocalImages (system, romBasename) {
    const types = ['covers', 'screenshots', 'miximages', 'titles'];
    types.forEach((type) => {
        const dir = path.join(config.imagesDir, system, type);
        IMG_EXTS.forEach((ext) => {
            const filePath = path.join(dir, romBasename + ext);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        });
    });
}

function loadSystemMetadata () {
    return new Promise((resolve) => {
        const xmlPath = path.join(__dirname, '../systems.xml');
        const metadata = {};
        if (!fs.existsSync(xmlPath)) return resolve(metadata);

        const parser = sax.createStream(false, { trim: true, lowercase: true });
        let currentSystem = null;
        let currentTag = null;

        parser.on('opentag', (node) => {
            currentTag = node.name;
            if (node.name === 'system') currentSystem = {};
        });
        parser.on('text', (text) => {
            if (currentSystem && currentTag) currentSystem[currentTag] = text;
        });
        parser.on('closetag', (tagName) => {
            if (tagName === 'system' && currentSystem && currentSystem.name) {
                metadata[currentSystem.name.toLowerCase()] = currentSystem;
                currentSystem = null;
            }
        });
        parser.on('end', () => resolve(metadata));

        parser.write('<root>');
        const fileStream = fs.createReadStream(xmlPath);
        fileStream.on('data', (c) => parser.write(c));
        fileStream.on('end', () => {
            parser.write('</root>');
            parser.end();
        });
    });
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

    const metadata = await loadSystemMetadata();

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
                const info = metadata[dir.toLowerCase()] || {};
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
                    (path, system, filename, name, image_path, desc, rating, releasedate, developer, publisher, genre, players) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                gamesBatch.forEach((g) =>
                    stmt.run(
                        g.path,
                        g.system,
                        g.filename,
                        g.name,
                        g.image_path,
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

                const gameData = {
                    path: path.join(system, romPath).replace(/\\/g, '/'),
                    system,
                    filename: romPath,
                    name: currentGame.name || basename,
                    image_path: imgPath,
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

async function syncSystem (system) {
    const state = getSystemStatus(system);
    if (state.syncing) return;

    state.syncing = true;
    state.logs = [];
    state.progress = { current: 0, total: 0 };
    addLog(system, '开始扫描文件系统...');

    const systemDir = path.join(config.romsDir, system);
    let diskFiles = [];
    try {
        diskFiles = fs.readdirSync(systemDir).filter((f) => ROM_EXTS.includes(path.extname(f).toLowerCase()));
    } catch (e) {
        addLog(system, `读取目录失败: ${e.message}`);
        state.syncing = false;
        return;
    }

    const dbGames = await new Promise((resolve) => {
        // 【修改】查询时带上 players，否则下面 undefined 判定不准
        db.all(
            'SELECT id, filename, desc, image_path, rating, players FROM games WHERE system = ?',
            [system],
            (err, rows) => {
                if (err) resolve([]);
                else resolve(rows || []);
            }
        );
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
            // 【核心修改】移除了 `|| g.rating === '0'` 的判断
            // 保留了玩家人数的判断 `|| !g.players`，以确保数据完整性
            const isIncomplete = !g.desc || g.desc === '暂无简介' || !g.image_path || !g.players;
            return isIncomplete;
        })
        .map((g) => g.filename);

    addLog(system, `扫描结果: 新增 ${toAdd.length}, 删除 ${toDelete.length}, 需重试 ${toUpdate.length}`);

    if (toDelete.length > 0) {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            const deleteStmt = db.prepare('DELETE FROM games WHERE id = ?');
            toDelete.forEach((game) => {
                const basename = path.basename(game.filename, path.extname(game.filename));
                deleteLocalImages(system, basename);
                deleteStmt.run(game.id);
                addLog(system, `[删除] ${game.filename}`);
            });
            deleteStmt.finalize();
            db.run('COMMIT');
        });
    }

    const taskSet = new Set([...toAdd, ...toUpdate]);
    const taskList = Array.from(taskSet);

    if (taskList.length === 0) {
        addLog(system, '所有文件已完美同步，无需操作。');
        state.syncing = false;
        return;
    }

    state.progress.total = taskList.length;
    let completedCount = 0;

    taskList.forEach((filename) => {
        queue.add(async () => {
            try {
                if (dbFilenameMap[filename]) {
                    await new Promise((resolve) => {
                        db.run('DELETE FROM games WHERE system = ? AND filename = ?', [system, filename], resolve);
                    });
                }

                await processNewGame(system, filename);

                completedCount++;
                state.progress.current = completedCount;

                if (completedCount === taskList.length) {
                    addLog(system, '所有任务执行完毕。');
                    state.syncing = false;
                }
            } catch (e) {
                completedCount++;
                state.progress.current = completedCount;
                addLog(system, `处理失败: ${filename}`);
                if (completedCount === taskList.length) {
                    state.syncing = false;
                }
            }
        });
    });

    addLog(system, `已将 ${taskList.length} 个任务加入后台队列 (新增+重试)，开始联网抓取...`);
}

async function processNewGame (system, filename) {
    const romPath = path.join(system, filename).replace(/\\/g, '/');
    const fullPath = path.join(config.romsDir, system, filename);
    const basename = path.basename(filename, path.extname(filename));

    let imagePath = findLocalImage(system, basename);

    const gameInfo = {
        name: basename,
        desc: '暂无简介',
        rating: '0',
        developer: '',
        publisher: '',
        genre: '',
        players: ''
    };

    addLog(system, `[处理中] ${filename} ...`);

    try {
        const scraperData = await scraper.fetchGameInfo(system, filename, fullPath);

        if (scraperData) {
            gameInfo.name = scraperData.name;
            gameInfo.desc = scraperData.desc;
            gameInfo.developer = scraperData.developer;
            gameInfo.publisher = scraperData.publisher;
            gameInfo.genre = scraperData.genre;
            gameInfo.rating = scraperData.rating;
            gameInfo.players = scraperData.players;

            addLog(system, `[抓取成功] 匹配为: ${scraperData.name}`);

            if (scraperData.boxArtUrl) {
                const targetPath = path.join(config.imagesDir, system, 'covers', basename + '.png');
                if (fs.existsSync(targetPath)) {
                    addLog(system, '  -> 封面已存在，跳过下载');
                } else {
                    await scraper.downloadFile(scraperData.boxArtUrl, targetPath);
                    addLog(system, '  -> 封面下载完成');
                }
                imagePath = path.join(system, 'covers', basename + '.png').replace(/\\/g, '/');
            }
            if (scraperData.screenUrl) {
                const targetPath = path.join(config.imagesDir, system, 'screenshots', basename + '.png');
                if (fs.existsSync(targetPath)) {
                    addLog(system, '  -> 截图已存在，跳过下载');
                } else {
                    await scraper.downloadFile(scraperData.screenUrl, targetPath);
                    addLog(system, '  -> 截图下载完成');
                }
            }
        } else {
            addLog(system, '[抓取未果] 未找到匹配信息');
        }
    } catch (e) {
        addLog(system, `[错误] ${e.message}`);
    }

    return new Promise((resolve) => {
        db.run(
            `INSERT INTO games (path, system, filename, name, image_path, desc, rating, developer, publisher, genre, players) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                romPath,
                system,
                filename,
                gameInfo.name,
                imagePath,
                gameInfo.desc,
                gameInfo.rating,
                gameInfo.developer,
                gameInfo.publisher,
                gameInfo.genre,
                gameInfo.players
            ],
            (err) => {
                if (!err) addLog(system, '[入库完成]');
                resolve();
            }
        );
    });
}

async function startScan () {
    console.log('=== 系统启动初始化 ===');
    await syncHostList();

    const systems = fs.readdirSync(config.romsDir).filter((file) => {
        const full = path.join(config.romsDir, file);
        return fs.statSync(full).isDirectory() && !file.startsWith('.') && !IGNORE_DIRS.includes(file.toLowerCase());
    });

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
    syncSystem,
    importGamelistXml,
    getSystemStatus
};
