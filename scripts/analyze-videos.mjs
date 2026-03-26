#!/usr/bin/env node
/**
 * 許可済み動画をClaude Codeで解析し、メタデータを自動付与するスクリプト
 * ffmpegでフレーム抽出 → claude CLIでカテゴリ等を判定 → DB書き込み
 */

import { mkdtempSync, rmSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import db from "../lib/db.mjs";
import { runCommand } from "../lib/command-runner.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");

// 解析対象: 許可済み & メタデータ未設定
function getTargets() {
  // --all フラグで全動画を対象にする
  if (process.argv.includes("--all")) {
    return db.prepare(
      "SELECT * FROM targets WHERE video_path IS NOT NULL AND category IS NULL"
    ).all();
  }
  return db.prepare(
    "SELECT * FROM targets WHERE reply_status = '許可' AND video_path IS NOT NULL AND category IS NULL"
  ).all();
}

// ffmpegで動画からフレームを等間隔に抽出
function extractFrames(videoPath, count = 5) {
  const tmpDir = mkdtempSync(join(tmpdir(), "dashcam-frames-"));
  const fullPath = resolve(DATA_DIR, videoPath);

  // 動画の長さを取得
  const duration = parseFloat(
    runCommand("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      fullPath,
    ]).stdout.trim()
  );

  // 等間隔にフレーム抽出
  const interval = duration / (count + 1);
  for (let i = 1; i <= count; i++) {
    const time = (interval * i).toFixed(2);
    runCommand("ffmpeg", [
      "-y",
      "-ss",
      time,
      "-i",
      fullPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      `${tmpDir}/frame_${i}.jpg`,
    ], {
      stdio: "pipe",
    });
  }

  const frames = readdirSync(tmpDir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => join(tmpDir, f));

  return { tmpDir, frames, duration };
}

// Claude CLIで解析
function analyzeWithClaude(frames) {
  const fileArgs = frames.map((f) => `"${f}"`).join(" ");

  const prompt = `これらはドライブレコーダーの映像から等間隔に抽出したフレームです。
映像の内容を分析して、以下のJSON形式で回答してください。JSONのみ出力し、他の説明は不要です。

{
  "categories": ["該当するカテゴリをすべて選択"],
  "location": ["該当する場所をすべて選択"],
  "weather": ["該当する天候/時間帯をすべて選択"],
  "danger_level": "高 or 中 or 低"
}

カテゴリ選択肢: 信号無視, 逆走, 煽り運転, 割り込み, 一時停止無視, 接触寸前, 方向指示器不使用, 速度超過, 危険運転, 飛び出し, 車間距離不保持, 蛇行運転, 当て逃げ, その他
場所選択肢: 交差点, 高速道路, 一般道, 住宅街, 駐車場, 細い道, 合流地点, カーブ
天候/時間帯選択肢: 晴れ, 曇り, 雨, 雪, 夜間, 夕方, 朝`;

  const result = runCommand(process.env.CLAUDE_BIN || "claude", ["-p", prompt, ...frames], {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  }).stdout;

  // JSONを抽出
  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude出力からJSONを抽出できませんでした: " + result);

  return JSON.parse(jsonMatch[0]);
}

// DB更新
function updateTarget(id, analysis, duration) {
  db.prepare(
    "UPDATE targets SET category = ?, location = ?, weather = ?, danger_level = ?, trim_start = ?, trim_end = ? WHERE id = ?"
  ).run(
    analysis.categories.join(","),
    analysis.location.join(","),
    analysis.weather.join(","),
    analysis.danger_level,
    0,
    Math.round(duration * 10) / 10,
    id
  );
}

async function main() {
  const targets = getTargets();
  console.log(`\n=== 動画解析 ===`);
  console.log(`対象: ${targets.length} 件\n`);

  if (targets.length === 0) {
    console.log("解析対象の動画がありません");
    return;
  }

  for (const target of targets) {
    console.log(`解析中: @${target.username} (${target.video_path})`);

    let tmpDir;
    try {
      const { tmpDir: td, frames, duration } = extractFrames(target.video_path);
      tmpDir = td;
      console.log(`  フレーム抽出: ${frames.length}枚 (${duration.toFixed(1)}秒)`);

      const analysis = analyzeWithClaude(frames);
      console.log(`  カテゴリ: ${analysis.categories.join(", ")}`);
      console.log(`  場所: ${analysis.location.join(", ")}`);
      console.log(`  天候: ${analysis.weather.join(", ")}`);
      console.log(`  危険度: ${analysis.danger_level}`);

      updateTarget(target.id, analysis, duration);
      console.log(`  → DB更新完了\n`);
    } catch (error) {
      console.error(`  エラー: ${error.message}\n`);
    } finally {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log("=== 解析完了 ===");
}

main().catch(console.error);
