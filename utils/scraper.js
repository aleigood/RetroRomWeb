/* eslint-disable n/no-callback-literal */
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

// 降低阈值到 64MB，加速大文件处理
const MD5_THRESHOLD = 64 * 1024 * 1024;

// 定义跳过 MD5 的大文件后缀
const LARGE_FILE_EXTS = ['.iso', '.chd', '.cso', '.wbfs', '.rvz'];

// 街机类平台的 System ID 列表 (参考 ScreenScraper 数据库)
// 75: Arcade, 142: NeoGeo, 56: Naomi, 53: Atomiswave, 70: NeoGeo CD
const ARCADE_SYSTEM_IDS = ['75', '142', '56', '53', '70'];

function calculateMD5 (filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(err));
    });
}

function getRomStem (filename) {
    return path.basename(filename, path.extname(filename));
}

// 简单的 HTML 实体解码 (Inspiration #5)
function decodeHtmlEntity (str) {
    if (!str) return '';
    return str
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#039;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&copy;/g, '©');
}

function cleanRomName (filename) {
    let name = filename;
    name = path.basename(name, path.extname(name));
    name = name.replace(/\[.*?\]/g, '');
    name = name.replace(/\(.*?\)/g, '');
    name = name.replace(/v\d+(\.\d+)?/gi, '');

    // Inspiration #3: 尝试移除开头的 "The "，有时能帮助匹配
    // 但为了保险起见，我们只在 Level 3 模糊搜索中使用这个 clean 后的名字
    // 如果名字本身就是 "The King of Fighters"，移除 The 可能变 "King of Fighters" 也挺好
    // 这里保持原有的替换逻辑，但要注意 ScreenScraper 对特殊符号敏感
    name = name.replace(/[&:\-_!.,;']/g, ' ');
    name = name.replace(/\s+/g, ' ').trim();
    return name;
}

async function downloadFile (url, savePath) {
    if (!url) return;
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: 30000
        });
        fs.ensureDirSync(path.dirname(savePath));
        const writer = fs.createWriteStream(savePath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', (err) => {
                fs.unlink(savePath, () => {});
                reject(err);
            });
        });
    } catch (e) {
        console.error(`[Scraper] 下载失败: ${url} - ${e.message}`);
    }
}

async function fetchGameInfo (system, filename, fullPath, explicitSystemId = null) {
    const ssConfig = config.screenScraper;
    if (!ssConfig || !ssConfig.devId || !ssConfig.devPassword) return null;

    const systemId = explicitSystemId;

    // 如果未配置 ID，直接尝试全局模糊搜索
    if (!systemId) {
        console.log(`[Scraper] 目录 ${system} 未配置 Scraper ID，跳过精准匹配，仅尝试全局搜索...`);
        return await searchWithFallback(null, filename, ssConfig);
    }

    let romSize = 0;
    try {
        if (fs.existsSync(fullPath)) romSize = fs.statSync(fullPath).size;
    } catch (e) {
        return null;
    }

    const romStem = getRomStem(filename);
    const cleanName = cleanRomName(filename);

    // Inspiration #1: 判断是否为街机系统或短文件名
    const isArcade =
        ARCADE_SYSTEM_IDS.includes(String(systemId)) ||
        system.toLowerCase().includes('arcade') ||
        system.toLowerCase().includes('mame');
    const isShortName = cleanName.length < 4;

    // === Level 1: MD5 精准匹配 ===
    const ext = path.extname(filename).toLowerCase();
    const isLargeFormat = LARGE_FILE_EXTS.includes(ext);

    // 如果是街机(通常 zip 很小)或者普通小文件，先算 MD5
    if (!isLargeFormat && romSize <= MD5_THRESHOLD) {
        console.log(`[Scraper] SystemID: ${systemId}, 计算 MD5 进行精准匹配...`);
        try {
            const romMD5 = await calculateMD5(fullPath);
            const result = await tryJeuInfosMD5(systemId, filename, romSize, romMD5, ssConfig);
            if (result) {
                console.log('[Scraper] ✅ MD5 精准命中!');
                return result;
            }
        } catch (e) {
            console.error(`[Scraper] MD5 流程出错: ${e.message}`);
        }
    } else {
        console.log('[Scraper] 文件较大或格式特殊，跳过 MD5 计算...');
    }

    // === Level 2: 文件名精确匹配 (romnom) ===
    console.log(`[Scraper] 尝试文件名匹配 (romnom): "${romStem}" (SystemID: ${systemId})`);
    const fileMatchResult = await tryJeuInfosFilename(systemId, romStem, ssConfig);
    if (fileMatchResult) {
        console.log(`[Scraper] ✅ 文件名匹配命中: ${fileMatchResult.name}`);
        return fileMatchResult;
    }

    // Inspiration #1: 如果是街机或者短文件名，到此为止，不进行模糊搜索
    // 因为模糊搜索对于 "kof97" 这种短词或街机文件名效果极差，容易匹配错
    if (isArcade) {
        console.log('[Scraper] ⚠️ 街机平台/MAME 不进行模糊搜索，以避免错误匹配。');
        return null;
    }
    if (isShortName) {
        console.log('[Scraper] ⚠️ 文件名过短 (<4 chars)，不进行模糊搜索。');
        return null;
    }

    // === Level 3: 文本搜索 (fallback) ===
    console.log('[Scraper] 文件名匹配失败，尝试文本模糊搜索...');
    return await searchWithFallback(systemId, filename, ssConfig);
}

async function tryJeuInfosMD5 (systemId, filename, romSize, romMD5, ssConfig) {
    const apiUrl = 'https://api.screenscraper.fr/api2/jeuInfos.php';
    const params = {
        devid: ssConfig.devId,
        devpassword: ssConfig.devPassword,
        softname: ssConfig.softname || 'RetroRomWeb',
        ssid: ssConfig.user,
        sspassword: ssConfig.password,
        output: 'json',
        systemeid: systemId,
        romtype: 'rom',
        romnom: filename,
        romtaille: romSize,
        md5: romMD5
    };

    try {
        const res = await axios.get(apiUrl, { params, timeout: 30000 });
        if (isValidGame(res.data)) {
            return parseGameData(res.data.response.jeu, filename);
        }
    } catch (e) {}
    return null;
}

async function tryJeuInfosFilename (systemId, romStem, ssConfig) {
    const apiUrl = 'https://api.screenscraper.fr/api2/jeuInfos.php';
    const params = {
        devid: ssConfig.devId,
        devpassword: ssConfig.devPassword,
        softname: ssConfig.softname || 'RetroRomWeb',
        ssid: ssConfig.user,
        sspassword: ssConfig.password,
        output: 'json',
        systemeid: systemId,
        romnom: romStem
    };

    try {
        const res = await axios.get(apiUrl, { params, timeout: 30000 });
        if (isValidGame(res.data)) {
            return parseGameData(res.data.response.jeu, romStem);
        }
    } catch (e) {}
    return null;
}

// Inspiration #2: 检查结果是否有效，过滤 ZZZ(notgame)
function isValidGame (data) {
    if (data && data.response && data.response.jeu && data.response.jeu.id) {
        const gameName = getLocalizedText(data.response.jeu.noms);
        if (gameName && gameName.toUpperCase().startsWith('ZZZ(NOTGAME)')) {
            console.log(`[Scraper] ⚠️ 忽略无效结果: ${gameName}`);
            return false;
        }
        return true;
    }
    return false;
}

async function searchWithFallback (systemId, filename, ssConfig) {
    let result = null;

    if (systemId) {
        result = await searchByText(systemId, filename, ssConfig);
        if (result) return result;

        console.log(`[Scraper] 指定系统 (ID:${systemId}) 内未找到 "${filename}"，停止搜索。`);
        return null;
    }

    console.log('[Scraper] 未指定系统 ID，执行全局搜索...');
    result = await searchByText(null, filename, ssConfig);
    if (result) {
        console.log('[Scraper] ✅ 全局搜索命中!');
        return result;
    }
    return null;
}

async function searchByText (systemId, filename, ssConfig) {
    const cleanName = cleanRomName(filename);
    const apiUrl = 'https://api.screenscraper.fr/api2/jeuRecherche.php';

    const params = {
        devid: ssConfig.devId,
        devpassword: ssConfig.devPassword,
        softname: ssConfig.softname || 'RetroRomWeb',
        ssid: ssConfig.user,
        sspassword: ssConfig.password,
        output: 'json',
        recherche: cleanName
    };

    if (systemId) params.systemeid = systemId;

    try {
        console.log(`[Scraper] 发起文件名搜索: "${cleanName}" (SystemID: ${systemId || 'All'})`);
        const res = await axios.get(apiUrl, { params, timeout: 30000 });

        if (res.data && res.data.response && res.data.response.jeux && res.data.response.jeux.length > 0) {
            // 这里我们取第一个不是 ZZZ(NOTGAME) 的结果
            const validMatch = res.data.response.jeux.find((g) => {
                const n = getLocalizedText(g.noms);
                return n && !n.toUpperCase().startsWith('ZZZ(NOTGAME)');
            });

            if (validMatch && validMatch.id) {
                console.log(`[Scraper] ✅ 搜索命中: ${getLocalizedText(validMatch.noms)} (ID: ${validMatch.id})`);
                return parseGameData(validMatch, filename);
            }
        }
    } catch (e) {
        console.error(`[Scraper] 搜索失败: ${e.message}`);
    }
    return null;
}

function getLocalizedText (arr) {
    if (!Array.isArray(arr)) return arr ? arr.text : '';
    const regions = ['us', 'jp', 'cn', 'zh', 'tw', 'hk', 'en', 'eu', 'ss'];
    for (const r of regions) {
        const found = arr.find((n) => n.region && n.region.toLowerCase() === r);
        if (found) return found.text;
    }
    return arr[0] ? arr[0].text : '';
}

function parseGameData (gameData, originalFilename) {
    const name = decodeHtmlEntity(getLocalizedText(gameData.noms) || cleanRomName(originalFilename));
    const desc = decodeHtmlEntity(getLocalizedText(gameData.synopsis)) || '暂无简介';
    const developer = decodeHtmlEntity(gameData.developpeur ? gameData.developpeur.text : '');
    const publisher = decodeHtmlEntity(gameData.editeur ? gameData.editeur.text : '');
    const players = gameData.joueurs
        ? typeof gameData.joueurs === 'string'
            ? gameData.joueurs
            : gameData.joueurs.text
        : '';

    let genre = '';
    if (gameData.genres && Array.isArray(gameData.genres) && gameData.genres.length > 0) {
        genre = getLocalizedText(gameData.genres[0].noms);
    } else if (gameData.genre && gameData.genre.text) {
        genre = gameData.genre.text;
    }

    const rating = gameData.note ? (parseInt(gameData.note.text, 10) / 20).toFixed(2) : '0';
    const releasedate = gameData.dates ? getLocalizedText(gameData.dates) : '';

    let boxArtUrl = '';
    let screenUrl = '';
    let videoUrl = '';
    let marqueeUrl = '';

    if (Array.isArray(gameData.medias)) {
        const availableTypes = gameData.medias.map((m) => `${m.type}(${m.region})`).join(', ');
        console.log(`[Scraper Debug] 游戏 "${name}" 可用媒体: ${availableTypes}`);

        const findMedia = (types, regionOrder = ['jp', 'us', 'en', 'eu', 'wor']) => {
            for (const r of regionOrder) {
                const m = gameData.medias.find(
                    (m) => types.includes(m.type.toLowerCase()) && m.region && m.region.toLowerCase() === r
                );
                if (m) return m.url;
            }
            const fallback = gameData.medias.find((m) => types.includes(m.type.toLowerCase()));
            return fallback ? fallback.url : null;
        };

        boxArtUrl = findMedia(['box-2d', 'box-3d']);
        screenUrl = findMedia(['ss', 'fanart']);
        videoUrl = findMedia(['video-normalized', 'video']);

        // Inspiration #4: 优先查找 wheel-hd
        marqueeUrl = findMedia(['wheel-hd', 'wheel', 'marquee', 'screenmarquee', 'screenmarqueesmall', 'sstitle']);

        if (!marqueeUrl) {
            console.log('[Scraper Debug] ⚠️ 未找到 Logo (wheel/marquee/title) 图片!');
        }
    }

    return {
        name,
        desc,
        developer,
        publisher,
        genre,
        players,
        rating,
        releasedate,
        boxArtUrl,
        screenUrl,
        videoUrl,
        marqueeUrl
    };
}

module.exports = {
    fetchGameInfo,
    downloadFile
};
