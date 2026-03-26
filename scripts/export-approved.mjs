#!/usr/bin/env node
/**
 * 許可済み動画をエクスポートするスクリプト
 * - data/approved/{username}_{tweet_id}/ に動画コピー + metadata.json を保存
 * - メタデータ未設定のものはスキップ（Claude Codeでメタデータ付与後に実行）
 */

import db from "../lib/db.mjs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");
const APPROVED_DIR = resolve(DATA_DIR, "approved");

function main() {
  const targets = db
    .prepare("SELECT * FROM targets WHERE reply_status = '許可'")
    .all();

  console.log(`=== 許可済み動画エクスポート ===\n`);
  console.log(`対象: ${targets.length} 件\n`);

  let exported = 0;
  let skipped = 0;

  for (const t of targets) {
    const dirName = `${t.username}_${t.tweet_id}`;
    const outDir = resolve(APPROVED_DIR, dirName);

    // 既にエクスポート済みならスキップ
    if (existsSync(resolve(outDir, "metadata.json"))) {
      console.log(`  スキップ（エクスポート済み）: @${t.username}`);
      skipped++;
      continue;
    }

    // 動画ファイル確認
    const videoSrc = t.video_path ? resolve(DATA_DIR, t.video_path) : null;
    if (!videoSrc || !existsSync(videoSrc)) {
      console.log(`  スキップ（動画なし）: @${t.username}`);
      skipped++;
      continue;
    }

    // ディレクトリ作成
    mkdirSync(outDir, { recursive: true });

    // 動画コピー
    const videoDest = resolve(outDir, `${t.tweet_id}.mp4`);
    copyFileSync(videoSrc, videoDest);
    console.log(`  動画コピー: ${videoDest}`);

    // メタデータJSON作成
    const metadata = {
      id: t.id,
      username: t.username,
      tweet_url: t.tweet_url,
      tweet_id: t.tweet_id,
      tweet_text: t.tweet_text || "",
      post_date: t.post_date || "",
      source: t.source,
      reply_status: t.reply_status,
      reply_date: t.reply_date,
      video_file: `${t.tweet_id}.mp4`,
      // メタデータ
      category: t.category || "",
      location: t.location || "",
      weather: t.weather || "",
      danger_level: t.danger_level || "",
      trim_start: t.trim_start ?? null,
      trim_end: t.trim_end ?? null,
      exported_at: new Date().toISOString(),
    };

    writeFileSync(resolve(outDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");
    console.log(`  メタデータ保存: ${dirName}/metadata.json`);
    exported++;
  }

  console.log(`\n=== 完了: ${exported} 件エクスポート / ${skipped} 件スキップ ===`);
}

main();
