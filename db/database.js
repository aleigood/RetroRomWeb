const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs-extra');
const config = require('../config');

// 使用配置中的路径
const dbPath = config.dbPath;
fs.ensureDirSync(path.dirname(dbPath));

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // 主机表
    db.run(`CREATE TABLE IF NOT EXISTS systems (
        name TEXT PRIMARY KEY,
        fullname TEXT,
        abbr TEXT,
        maker TEXT,
        release_year TEXT,
        desc TEXT,
        history TEXT,
        count INTEGER DEFAULT 0
    )`);

    // 游戏表 - 【修改】增加了 video_path 字段
    // 注意：原来的 image_path 就是用来存封面的
    db.run(`CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE,
        system TEXT,
        filename TEXT,
        name TEXT,
        image_path TEXT,
        video_path TEXT,
        desc TEXT,
        rating TEXT,
        releasedate TEXT,
        developer TEXT,
        publisher TEXT,
        genre TEXT,
        players TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 创建索引
    db.run('CREATE INDEX IF NOT EXISTS idx_games_system ON games(system)');
    db.run('CREATE INDEX IF NOT EXISTS idx_games_name ON games(name)');
});

module.exports = db;
