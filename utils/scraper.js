const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
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

// 辅助函数：清洗文件名
function cleanRomName (filename) {
    let name = filename;
    name = path.basename(name, path.extname(name));
    name = name.replace(/\[.*?\]/g, ''); // 去掉 []
    name = name.replace(/\(.*?\)/g, ''); // 去掉 ()
    // 去掉一些常见的无用词
    name = name.replace(/v\d+/gi, '');
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
            timeout: 15000
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

async function fetchGameInfo (system, filename) {
    const ssConfig = config.screenScraper;

    // 【调试】打印当前使用的配置（隐藏密码）
    // console.log(`[Scraper] Config: DevID=${ssConfig.devId}, User=${ssConfig.user}`);

    const systemId = SYSTEM_MAP[system.toLowerCase()];
    if (!systemId) {
        console.log(`[Scraper] 不支持的系统 ID: ${system}`);
        return null;
    }

    const cleanName = cleanRomName(filename);
    const candidates = [cleanName];
    // 如果清洗后的名字和原名不一样，把原名也加上作为候补
    if (cleanName !== path.basename(filename, path.extname(filename))) {
        candidates.push(path.basename(filename, path.extname(filename)));
    }

    const apiUrl = 'https://www.screenscraper.fr/api2/jeuInfos.php';

    for (const romnom of candidates) {
        if (!romnom || romnom.length < 2) continue;

        try {
            const params = {
                output: 'json',
                romnom,
                systemeid: systemId
            };

            // 只有当配置了 DevID 时才发送认证信息
            // 如果只有用户名没有 DevID，API 会报错，不如不发用户名
            if (ssConfig.devId && ssConfig.devPassword) {
                params.devid = ssConfig.devId;
                params.devpassword = ssConfig.devPassword;
                params.softname = ssConfig.softname || 'RetroRomWeb';

                // 只有在有 DevID 的情况下，发送 User 才有意义
                if (ssConfig.user && ssConfig.password) {
                    params.ssid = ssConfig.user;
                    params.sspassword = ssConfig.password;
                }
            }

            console.log(`[Scraper] 请求: [${system}] "${romnom}"`);

            const res = await axios.get(apiUrl, { params, timeout: 15000 });

            // 【关键】检查 API 是否返回了逻辑错误
            // ScreenScraper 有时返回 200，但内容是 error
            if (res.data && res.data.header && res.data.header.error) {
                console.error(`[Scraper] API 拒绝: ${res.data.header.error}`);
                // 如果是凭证错误，继续尝试也没用，直接跳出
                if (res.data.header.error.includes('Credentials')) return null;
                continue;
            }

            if (res.data && res.data.response && res.data.response.jeu) {
                const gameData = res.data.response.jeu;
                // console.log(`[Scraper] 命中: ${gameData.noms[0]?.text}`);
                return parseGameData(gameData, filename);
            } else {
                console.log(`[Scraper] API 返回空数据 (Name: ${romnom})`);
            }
        } catch (error) {
            // 打印详细的网络错误
            if (error.response) {
                console.error(`[Scraper] HTTP Error ${error.response.status}: ${JSON.stringify(error.response.data)}`);
            } else {
                console.error(`[Scraper] Network Error: ${error.message}`);
            }
        }
    }

    return null;
}

function parseGameData (gameData, originalFilename) {
    const getLocalizedText = (arr) => {
        if (!Array.isArray(arr)) return arr ? arr.text : '';
        const regions = ['cn', 'zh', 'tw', 'hk', 'en', 'ss', 'jp'];
        for (const r of regions) {
            const found = arr.find((n) => n.region.toLowerCase() === r);
            if (found) return found.text;
        }
        return arr[0] ? arr[0].text : '';
    };

    const name = getLocalizedText(gameData.noms) || path.basename(originalFilename, path.extname(originalFilename));
    const desc = getLocalizedText(gameData.synopsis) || '暂无简介';
    const developer = gameData.developpeur ? gameData.developpeur.text : '';
    const publisher = gameData.editeur ? gameData.editeur.text : '';
    const genre = gameData.genre ? gameData.genre.text : '';
    const rating = gameData.note ? (parseInt(gameData.note.text, 10) / 20).toFixed(2) : '0';

    let boxArtUrl = '';
    let screenUrl = '';

    if (Array.isArray(gameData.medias)) {
        const box =
            gameData.medias.find((m) => m.type === 'box-2d') || gameData.medias.find((m) => m.type === 'box-3d');
        if (box) boxArtUrl = box.url;

        const shot = gameData.medias.find((m) => m.type === 'ss') || gameData.medias.find((m) => m.type === 'fanart');
        if (shot) screenUrl = shot.url;
    }

    return {
        name,
        desc,
        developer,
        publisher,
        genre,
        rating,
        boxArtUrl,
        screenUrl
    };
}

module.exports = {
    fetchGameInfo,
    downloadFile
};
