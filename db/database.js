const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const config = require('../config');
const fs = require('fs-extra');

// 确保数据目录存在
fs.ensureDirSync(path.dirname(config.dbPath));

const db = new sqlite3.Database(config.dbPath, (err) => {
    if (err) {
        console.error('Database opening error: ', err);
    } else {
        console.log('Database connected.');
        initDb();
    }
});

function initDb () {
    db.serialize(() => {
        // 游戏表
        db.run(`CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE,
            system TEXT,
            filename TEXT,
            name TEXT,
            image_path TEXT,
            desc TEXT,
            rating TEXT,
            releasedate TEXT,
            developer TEXT,
            publisher TEXT,
            genre TEXT
        )`);

        // 新增：主机信息表 (增加了 abbr 字段)
        // ⚠️ 请删除旧的 .sqlite 文件以使表结构更改生效
        db.run(`CREATE TABLE IF NOT EXISTS systems (
            name TEXT PRIMARY KEY,
            fullname TEXT,
            abbr TEXT,
            maker TEXT,
            release_year TEXT,
            desc TEXT,
            history TEXT
        )`);

        // 创建索引
        db.run('CREATE INDEX IF NOT EXISTS idx_games_system ON games(system)');
        db.run('CREATE INDEX IF NOT EXISTS idx_games_name ON games(name)');
    });
}

module.exports = db;
