---
description: 許可済み動画を解析してメタデータ（カテゴリ・場所・天候・危険度）を付与しエクスポートする。「メタデータつけて」「許可済み解析して」「動画分析して」など。
---

# analyze-approved

許可済み動画を解析してメタデータを付与し、エクスポートするスキル。

## トリガー

「メタデータつけて」「許可済み解析して」「動画分析して」など、許可済み動画のメタデータ付与を依頼された時

## 手順

1. DBから許可済み（reply_status = '許可'）かつメタデータ未設定（category IS NULL または category = ''）のレコードを取得する

```bash
node -e "
const db = require('better-sqlite3')('./data/dashcam.db');
const rows = db.prepare(\"SELECT id, username, tweet_id, tweet_text, video_path, category FROM targets WHERE reply_status = '許可' AND (category IS NULL OR category = '')\").all();
if (rows.length === 0) { console.log('メタデータ未設定の許可済み動画はありません'); process.exit(0); }
rows.forEach(r => console.log(JSON.stringify(r)));
"
```

2. 各動画について、ffmpegでフレームを5枚抽出する（等間隔）

```bash
# 動画の長さを取得
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "data/videos/{tweet_id}.mp4")

# 5枚のフレームを等間隔で抽出（/tmp/frames_{tweet_id}/ に保存）
mkdir -p /tmp/frames_{tweet_id}
ffmpeg -i "data/videos/{tweet_id}.mp4" -vf "select='isnan(prev_selected_t)+gte(t-prev_selected_t\,${DURATION}/5)',scale=640:-1" -vsync vfr -frames:v 5 "/tmp/frames_{tweet_id}/frame_%02d.jpg" -y
```

3. 抽出したフレーム画像を Read ツールで読み込んで分析する。以下の観点で分類：

- **category**: 違反/事故の種類（複数可、カンマ区切り）
  - 選択肢: 信号無視, 逆走, 煽り運転, 割り込み, 一時停止無視, 接触寸前, 方向指示器不使用, 速度超過, 危険運転, 飛び出し, 車間距離不保持, 蛇行運転, 当て逃げ, スマホ運転, その他
- **location**: 場所/道路タイプ（複数可）
  - 選択肢: 交差点, 高速道路, 一般道, 住宅街, 駐車場, 細い道, 合流地点, カーブ
- **weather**: 天候/時間帯（複数可）
  - 選択肢: 晴れ, 曇り, 雨, 雪, 夜間, 夕方, 朝
- **danger_level**: 危険度
  - 選択肢: 高, 中, 低

ツイート本文も参考にするが、動画の映像を優先して判断する。

4. 分類結果をDBに保存する

```bash
node -e "
const db = require('better-sqlite3')('./data/dashcam.db');
db.prepare('UPDATE targets SET category = ?, location = ?, weather = ?, danger_level = ? WHERE id = ?')
  .run('カテゴリ', '場所', '天候', '危険度', ID);
console.log('メタデータ保存完了: ID=' + ID);
"
```

5. 全件処理後、エクスポートを実行する

```bash
node scripts/export-approved.mjs
```

6. 結果をユーザーに報告する。各動画について：
   - ユーザー名
   - 付与したメタデータ
   - エクスポート先パス

## 注意

- フレーム画像は処理後に `/tmp/frames_{tweet_id}/` を削除する
- 既にメタデータが設定済みのものはスキップする
- 判断に迷う場合はユーザーに確認する
