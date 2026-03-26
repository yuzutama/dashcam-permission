# dashcam-permission

ドラレコ動画の「使用許可取り」を、手元のPCで進めるためのツールです。

X上の動画付き投稿を集めて、管理画面で内容を確認し、許可申請の返信を送り、その後の返事まで追えるようにしています。

「完全自動で全部おまかせ」というより、候補集めと管理を楽にするための運用ツールです。

## このツールでできること

- 動画付きの投稿候補を集める
- 投稿者情報や投稿本文を保存する
- 管理画面で候補を見て、送るかどうか判断する
- 許可申請の返信を送る
- 相手から返事が来たかを確認する
- 許可済みの動画を整理して書き出す

## まず最初に読むところ

はじめて使う場合は、まずこの順番で進めるのがおすすめです。

1. `npm install`
2. `.env` を作る
3. `npm run db:init`
4. `npm run fetch`
5. `npm run dev`

ここまでできれば、候補収集と管理画面の確認までは進められます。

## 動作に必要なもの

### 必須

- Node.js 18以上
- X API の認証情報
- `yt-dlp`

### あると使えるもの

- `ffmpeg` / `ffprobe`
  - 動画解析で使います
- `codex` CLI または `claude` CLI
  - 返信文の判定補助で使います
- `claude` CLI
  - 動画解析で使います

## セットアップ

### 1. 依存パッケージを入れる

```bash
npm install
```

### 2. `.env` を作る

まずサンプルをコピーします。

```bash
cp .env.example .env
```

そのあと、`.env` に X API のキーを入れます。

```env
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
```

まだ API キーがない場合は、ここが埋まるまで先に進めません。

### 3. データベースを初期化する

```bash
npm run db:init
```

これで `data/dashcam.db` が作られます。

## 使い方

### 1. 候補を集める

```bash
npm run fetch
```

この処理でやっていること:

- 監視対象アカウントの投稿を見にいく
- リプライ先の投稿をたどる
- 動画付きの投稿を見つける
- 動画や投稿情報をローカルに保存する

保存先:

- 動画: `data/videos/`
- DB: `data/dashcam.db`

### 2. 管理画面で確認する

```bash
npm run dev
```

起動したら、ブラウザで `http://localhost:3456` を開きます。

管理画面では次のことができます。

- 動画を再生して中身を見る
- 投稿文や投稿者情報を確認する
- 送信候補にするか決める
- ブロック対象を管理する
- 返信文を確認する
- 設定を変える

### 3. 許可申請の返信を送る

```bash
npm run send
```

送信されるのは、管理画面などで送信対象になっているものだけです。

送信後は、状態が `送信済み` または `エラー` に変わります。

### 4. 返事をチェックする

```bash
npm run check
```

相手から返事が来ているかを確認し、次のように分類します。

- `許可`
- `拒否`
- `返信あり`
- `判定不可`

LLM が使えない場合は、キーワード判定だけで運用することもできます。

### 5. 許可済み動画を書き出す

```bash
npm run export
```

書き出し先は `data/approved/` です。

各動画ごとにフォルダが作られ、その中に動画ファイルと `metadata.json` が入ります。

## よく使うコマンド

| コマンド | 役割 |
| --- | --- |
| `npm run fetch` | 候補を集める |
| `npm run dev` | 管理画面を開く |
| `npm run send` | 許可申請の返信を送る |
| `npm run check` | 返事を確認する |
| `npm run export` | 許可済み動画を書き出す |
| `npm run profiles` | 投稿者プロフィールを補完する |
| `npm run analyze` | 許可済み動画を解析する |
| `npm run analyze:all` | 解析を全件やり直す |
| `npm run db:init` | DB を初期化する |

## 迷ったらこの順番

最小構成で使うなら、次の順で十分です。

```bash
npm install
cp .env.example .env
npm run db:init
npm run fetch
npm run dev
```

送信まで進めるときは、そのあとにこれを実行します。

```bash
npm run send
npm run check
```

## 補足

### 設定の初期値

初期値は `lib/constants.mjs` にあります。

一部の設定は、管理画面から変更できます。

### データの保存先

- DB: `data/dashcam.db`
- 収集した動画: `data/videos/`
- 書き出した動画: `data/approved/`

### Git に含めないもの

次のようなファイルは Git に含めない設定です。

- `.env`
- DB ファイル
- `data` 配下の `.mp4`
- `node_modules`

## つまずきやすいポイント

### `npm run fetch` がうまく動かない

まず `.env` の X API キーが正しく入っているか確認してください。

### 動画が取れない

`yt-dlp` が入っていない可能性があります。

### 管理画面が開けない

`npm run dev` を実行したあとに、`http://localhost:3456` を開いているか確認してください。

### 返信判定がうまくいかない

`codex` CLI や `claude` CLI がない環境では、LLM を使う判定が動かないことがあります。

その場合は、キーワード判定中心で運用してください。
