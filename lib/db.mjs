import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../data/dashcam.db");
const SCHEMA_PATH = resolve(__dirname, "../db/schema.sql");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// スキーマ初期化
const schema = readFileSync(SCHEMA_PATH, "utf-8");
db.exec(schema);

// マイグレーション: 投稿者プロフィール + メタデータカラム追加
const profileCols = ["display_name", "profile_image_url", "profile_description"];
const metaCols = ["category", "trim_start", "trim_end", "violation_info", "memo", "location", "weather", "danger_level", "received_reply_text", "trimmed_video_path", "trimmed_at", "asset_status", "project_id", "sort_order", "selected_comment", "editor_note"];
const existing = db.prepare("PRAGMA table_info(targets)").all().map((c) => c.name);
for (const col of [...profileCols, ...metaCols]) {
  if (!existing.includes(col)) {
    const type = col.startsWith("trim_")
      ? "REAL"
      : col === "project_id" || col === "sort_order"
        ? "INTEGER"
        : "TEXT";
    db.exec(`ALTER TABLE targets ADD COLUMN ${col} ${type}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_users (
    username TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_code TEXT UNIQUE NOT NULL,
    title TEXT,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

export default db;

// CLI: node lib/db.mjs init
if (process.argv[2] === "init") {
  console.log("DB初期化完了: " + DB_PATH);
}
