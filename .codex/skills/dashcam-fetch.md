---
name: dashcam-fetch
description: ドラレコ動画の収集・管理 - 競合チャンネルがリプライしている動画付きツイートを収集し、動画をダウンロードする。管理画面の起動も対応。
metadata:
  tags: dashcam, twitter, video, scraping
---

## いつ使うか

- 「動画集めて」「ドラレコ収集」「fetch」など、動画収集の依頼があったとき → Step 1〜5 を実行
- 「管理画面開いて」「プレビュー見せて」「動画確認したい」など、管理画面の起動依頼があったとき → 管理画面起動 を実行

## 実行手順

### Step 1: 環境確認

以下を確認する:
- `.env` ファイルが存在すること（Twitter APIキーが設定済み）
- `node_modules` が存在すること（なければ `npm install`）
- `yt-dlp` がインストール済みであること

### Step 2: 現在のDB状態を確認

```bash
node -e "
const db = (await import('./lib/db.mjs')).default;
const count = db.prepare('SELECT COUNT(*) as c FROM targets').get();
const recent = db.prepare('SELECT username, tweet_url, created_at FROM targets ORDER BY created_at DESC LIMIT 5').all();
console.log('現在の登録数:', count.c, '件');
console.log('最新5件:');
recent.forEach(r => console.log(' ', r.username, r.tweet_url));
"
```

現在の状態をユーザーに報告する。

### Step 3: 収集実行

```bash
npm run fetch
```

タイムアウトは5分に設定する（動画DLに時間がかかるため）。

### Step 4: 結果報告

収集結果をユーザーに報告する:
- 新規追加件数
- DL成功/失敗数
- エラーがあれば内容

### Step 5（任意）: 管理画面の案内

新規動画がある場合、管理画面で確認できることを案内する:

```
npm run dev で http://localhost:3456 を開くと動画をプレビューできます。
```

## 設定

競合アカウントやクロール期間を変更したい場合は `lib/constants.mjs` を編集する:

| 項目 | 設定ファイル |
|------|------------|
| 競合アカウント | `lib/constants.mjs` の `COMPETITOR_ACCOUNTS` |
| クロール期間 | `lib/constants.mjs` の `CRAWL_DAYS`（デフォルト7日） |

## 管理画面起動

```bash
npm run dev
```

ブラウザで http://localhost:3456 を開くよう案内する。

## エラー対処

| エラー | 対処 |
|--------|------|
| 429 Rate Limit | Twitter APIのレート制限。15分待ってから再実行 |
| yt-dlp失敗 | 動画が削除済み or 非公開の可能性。スキップしてOK |
| .env未設定 | `.env.example` をコピーしてAPIキーを設定するよう案内 |
