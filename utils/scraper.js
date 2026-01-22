/* eslint-disable n/no-callback-literal */
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

// 【修改】移除硬编码的 SYSTEM_MAP，现在由配置文件控制

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
    name = name.replace(/\[.*?\]/g, '');
    name = name.replace(/\(.*?\)/g, '');
    name = name.replace(/v\d+(\.\d+)?/gi, '');
    name = name.replace(/[-_.]/g, ' ');
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

// 【修改】新增 explicitSystemId 参数
async function fetchGameInfo (system, filename, fullPath, explicitSystemId = null) {
    const ssConfig = config.screenScraper;
    if (!ssConfig || !ssConfig.devId || !ssConfig.devPassword) return null;

    // 优先使用传入的 ID，如果没有，则无法精确抓取
    const systemId = explicitSystemId;

    if (!systemId) {
        console.log(`[Scraper] 目录 ${system} 未配置 Scraper ID，跳过精准匹配，仅尝试全局搜索...`);
        // 如果没有 ID，直接去全局搜索，不计算 MD5 了，因为 MD5 接口通常需要 ID
        return await searchWithFallback(null, filename, ssConfig);
    }

    let romSize = 0;
    try {
        if (fs.existsSync(fullPath)) romSize = fs.statSync(fullPath).size;
    } catch (e) {
        return null;
    }

    if (romSize > MD5_THRESHOLD) {
        console.log('[Scraper] 文件较大，跳过 MD5 计算，直接使用文件名搜索...');
        return await searchWithFallback(systemId, filename, ssConfig);
    }

    console.log(`[Scraper] SystemID: ${systemId}, 计算 MD5 进行精准匹配...`);
    try {
        const romMD5 = await calculateMD5(fullPath);
        const result = await tryJeuInfos(systemId, filename, romSize, romMD5, ssConfig);

        if (result) {
            console.log('[Scraper] ✅ MD5 精准命中!');
            return result;
        }
    } catch (e) {
        console.error(`[Scraper] MD5 流程出错: ${e.message}`);
    }

    return await searchWithFallback(systemId, filename, ssConfig);
}

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
        const res = await axios.get(apiUrl, { params, timeout: 30000 });
        if (res.data && res.data.response && res.data.response.jeu && res.data.response.jeu.id) {
            return parseGameData(res.data.response.jeu, filename);
        }
    } catch (e) {}
    return null;
}

async function searchWithFallback (systemId, filename, ssConfig) {
    let result = null;

    // 如果有 ID，先在系统内搜索
    if (systemId) {
        result = await searchByText(systemId, filename, ssConfig);
        if (result) return result;
    }

    console.log('[Scraper] 指定系统未找到，尝试全局搜索...');
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
            const firstMatch = res.data.response.jeux[0];
            if (firstMatch && firstMatch.id) {
                console.log(`[Scraper] ✅ 搜索命中: ${getLocalizedText(firstMatch.noms)} (ID: ${firstMatch.id})`);
                return parseGameData(firstMatch, filename);
            }
        }
    } catch (e) {
        console.error(`[Scraper] 搜索失败: ${e.message}`);
    }
    return null;
}

function getLocalizedText (arr) {
    if (!Array.isArray(arr)) return arr ? arr.text : '';
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
        const box =
            gameData.medias.find((m) => m.type === 'box-3d') || gameData.medias.find((m) => m.type === 'box-2d');
        if (box) boxArtUrl = box.url;

        const shot = gameData.medias.find((m) => m.type === 'fanart') || gameData.medias.find((m) => m.type === 'ss');
        if (shot) screenUrl = shot.url;

        const video = gameData.medias.find((m) => m.type === 'video' || m.type === 'video-normalized');
        if (video) videoUrl = video.url;

        const wheel = gameData.medias.find((m) => m.type === 'wheel' || m.type === 'marquee');
        if (wheel) marqueeUrl = wheel.url;
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
