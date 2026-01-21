/*
type: uploaded file
fileName: 新建文件夹/utils/scraper.js
*/
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

// 系统 ID 映射表
const SYSTEM_MAP = {
    nes: 3,
    famicom: 3,
    snes: 4,
    sfc: 4,
    gb: 9,
    gba: 12,
    md: 1,
    megadrive: 1,
    genesis: 1,
    n64: 14,
    nds: 15,
    psx: 57,
    ps1: 57,
    psp: 150,
    psv: 59,
    psvita: 59,
    mame: 75,
    fba: 75,
    fbneo: 75,
    neogeo: 142,
    wii: 16,
    gc: 13,
    ngc: 13,
    dc: 23,
    dreamcast: 23,
    saturn: 22,
    pce: 31,
    pcengine: 31,
    x68000: 79,
    switch: 145,
    nx: 145,
    nsw: 145
};

// 【核心优化】超过 256MB 的文件跳过 MD5 计算，直接用文件名搜索
const MD5_THRESHOLD = 256 * 1024 * 1024;

function calculateMD5 (filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(err));
    });
}

function cleanRomName (filename) {
    let name = filename;
    name = path.basename(name, path.extname(name));
    // 移除方括号及其内容 [xxx]
    name = name.replace(/\[.*?\]/g, '');
    // 移除圆括号及其内容 (xxx)
    name = name.replace(/\(.*?\)/g, '');
    // 移除常见版本号 v1.0, v2 等
    name = name.replace(/v\d+(\.\d+)?/gi, '');
    // 移除多余空格、连字符等干扰字符
    name = name.replace(/[-_.]/g, ' ');
    name = name.replace(/\s+/g, ' ').trim();
    return name;
}

// 打印调试链接
function logDebugUrl (baseUrl, params) {
    const cleanParams = {};
    Object.keys(params).forEach((key) => {
        if (params[key] !== undefined && params[key] !== null) {
            cleanParams[key] = params[key];
        }
    });
    // 隐藏密码
    const debugParams = { ...cleanParams };
    if (debugParams.devpassword) debugParams.devpassword = '***';
    if (debugParams.sspassword) debugParams.sspassword = '***';

    console.log(`[Scraper] API URL: ${baseUrl}?${new URLSearchParams(debugParams).toString()}`);
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

async function fetchGameInfo (system, filename, fullPath) {
    const ssConfig = config.screenScraper;
    if (!ssConfig || !ssConfig.devId || !ssConfig.devPassword) return null;

    const systemId = SYSTEM_MAP[system.toLowerCase()];
    if (!systemId) {
        console.log(`[Scraper] 未知系统: ${system}, 无法获取 ID`);
        return null;
    }

    // 1. 获取文件大小
    let romSize = 0;
    try {
        if (fs.existsSync(fullPath)) romSize = fs.statSync(fullPath).size;
    } catch (e) {
        return null;
    }

    // 2. 策略判断
    if (romSize > MD5_THRESHOLD) {
        console.log(
            `[Scraper] 文件较大 (${(romSize / 1024 / 1024).toFixed(2)} MB)，跳过 MD5 计算，直接使用文件名搜索...`
        );
        return await searchWithFallback(systemId, filename, ssConfig);
    }

    // 3. 小文件尝试 MD5 精准匹配
    console.log('[Scraper] 文件较小，计算 MD5 进行精准匹配...');
    try {
        const romMD5 = await calculateMD5(fullPath);
        // 尝试精准匹配
        const result = await tryJeuInfos(systemId, filename, romSize, romMD5, ssConfig);

        if (result) {
            console.log('[Scraper] ✅ MD5 精准命中!');
            return result;
        } else {
            console.log('[Scraper] ⚠️ MD5 未命中 (API返回 NotFound)，切换至文件名搜索...');
        }
    } catch (e) {
        console.error(`[Scraper] MD5 流程出错: ${e.message}`);
    }

    // 4. 兜底：文件名搜索
    return await searchWithFallback(systemId, filename, ssConfig);
}

// 策略 A: 精准匹配 (jeuInfos.php)
async function tryJeuInfos (systemId, filename, romSize, romMD5, ssConfig) {
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
        // logDebugUrl(apiUrl, params);
        const res = await axios.get(apiUrl, { params, timeout: 30000 });

        // 【修复】增加对 id 的检查，防止空对象 {} 被视为成功
        if (res.data && res.data.response && res.data.response.jeu && res.data.response.jeu.id) {
            return parseGameData(res.data.response.jeu, filename);
        }
    } catch (e) {
        // 忽略 404 等错误
    }
    return null;
}

// 组合策略：先带 SystemID 搜，搜不到再全局搜
async function searchWithFallback (systemId, filename, ssConfig) {
    // 第一次尝试：带系统 ID
    let result = await searchByText(systemId, filename, ssConfig);
    if (result) return result;

    // 第二次尝试：如果不带 ID 能搜到，可能归类不同，尝试全局搜索
    console.log('[Scraper] 指定系统未找到，尝试全局搜索...');
    result = await searchByText(null, filename, ssConfig);
    if (result) {
        console.log('[Scraper] ✅ 全局搜索命中!');
        return result;
    }

    return null;
}

// 策略 B: 文件名搜索 (jeuRecherche.php)
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

    // 如果有 systemId 才传，否则全局搜索
    if (systemId) {
        params.systemeid = systemId;
    }

    try {
        console.log(`[Scraper] 发起文件名搜索: "${cleanName}" (SystemID: ${systemId || 'All'})`);
        logDebugUrl(apiUrl, params);

        const res = await axios.get(apiUrl, { params, timeout: 30000 });

        // 【关键修复】ScreenScraper 在无结果时可能返回 [{}]，必须检查 id 属性是否存在
        if (res.data && res.data.response && res.data.response.jeux && res.data.response.jeux.length > 0) {
            const firstMatch = res.data.response.jeux[0];

            // 只有当存在有效 ID 时才认为找到了
            if (firstMatch && firstMatch.id) {
                console.log(`[Scraper] ✅ 搜索命中: ${getLocalizedText(firstMatch.noms)} (ID: ${firstMatch.id})`);
                return parseGameData(firstMatch, filename);
            }
        }

        console.log('[Scraper] ❌ 文件名搜索无结果 (API返回空或无效数据)');
    } catch (e) {
        console.error(`[Scraper] 搜索失败: ${e.message}`);
    }
    return null;
}

// 辅助函数：获取本地化文本
function getLocalizedText (arr) {
    if (!Array.isArray(arr)) return arr ? arr.text : '';
    // 优先匹配中文，其次英文，最后原文
    const regions = ['cn', 'zh', 'tw', 'hk', 'en', 'ss', 'jp', 'us', 'eu'];
    for (const r of regions) {
        const found = arr.find((n) => n.region && n.region.toLowerCase() === r);
        if (found) return found.text;
    }
    return arr[0] ? arr[0].text : '';
}

function parseGameData (gameData, originalFilename) {
    const name = getLocalizedText(gameData.noms) || cleanRomName(originalFilename);
    const desc = getLocalizedText(gameData.synopsis) || '暂无简介';
    const developer = gameData.developpeur ? gameData.developpeur.text : '';
    const publisher = gameData.editeur ? gameData.editeur.text : '';

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

    if (Array.isArray(gameData.medias)) {
        // 优先找 3D 盒封，没有再找 2D
        const box =
            gameData.medias.find((m) => m.type === 'box-3d') || gameData.medias.find((m) => m.type === 'box-2d');
        if (box) boxArtUrl = box.url;

        // 优先找 Fanart (背景图)，没有再找截图
        const shot = gameData.medias.find((m) => m.type === 'fanart') || gameData.medias.find((m) => m.type === 'ss');
        if (shot) screenUrl = shot.url;
    }

    return {
        name,
        desc,
        developer,
        publisher,
        genre,
        rating,
        releasedate,
        boxArtUrl,
        screenUrl
    };
}

module.exports = {
    fetchGameInfo,
    downloadFile
};
