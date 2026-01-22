// ====================================================
// 这是配置文件模板 (Template)
// 使用方法：
// 1. 复制此文件并重命名为 'config.js'
// 2. 在 'config.js' 中填入您的真实信息
// ====================================================

const path = require('path');

module.exports = {
    // 服务端口
    port: 3000,

    // ROM 存放目录 (可以是绝对路径，也可以是相对路径)
    romsDir: path.join(__dirname, 'roms'),

    // 图片/资源存放目录
    mediaDir: path.join(__dirname, 'public', 'images'),

    // ScreenScraper API 配置
    // 如果没有账号，可以使用通用的匿名配置，但配额很少。
    // 申请账号地址: https://www.screenscraper.fr/
    screenScraper: {
        // 软件识别名 (不需要改)
        softname: 'RetroRomWeb',

        // 您的 ScreenScraper 开发者 ID (如果是个人使用，也可以尝试留空或使用 'Universal_XML_Scraper')
        devId: 'YOUR_DEVID_HERE',
        devPassword: 'YOUR_DEVPASSWORD_HERE',

        // 您的 ScreenScraper 用户账号 (必填，否则 API 限制极严)
        user: 'YOUR_USERNAME_HERE',
        password: 'YOUR_PASSWORD_HERE'
    }
};
