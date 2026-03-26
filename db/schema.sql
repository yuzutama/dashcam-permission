CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  display_name TEXT,
  profile_image_url TEXT,
  profile_description TEXT,
  tweet_url TEXT UNIQUE NOT NULL,
  tweet_id TEXT NOT NULL,
  video_path TEXT,
  post_date TEXT,
  source TEXT,
  status TEXT DEFAULT '未送信',
  reply_tweet_id TEXT,
  reply_status TEXT DEFAULT '-',
  reply_date TEXT,
  send_check INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  -- メタデータ
  category TEXT,
  trim_start REAL,
  trim_end REAL,
  violation_info TEXT,
  memo TEXT,
  location TEXT,
  weather TEXT,
  danger_level TEXT,
  tweet_text TEXT,
  reply_text TEXT,
  received_reply_text TEXT,
  trimmed_video_path TEXT,
  trimmed_at TEXT,
  asset_status TEXT,
  project_id INTEGER,
  sort_order INTEGER,
  selected_comment TEXT,
  editor_note TEXT
);

CREATE TABLE IF NOT EXISTS blocked_users (
  username TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_code TEXT UNIQUE NOT NULL,
  title TEXT,
  status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);
