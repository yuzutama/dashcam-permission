#!/usr/bin/env node

import "dotenv/config";
import { commandExists } from "../lib/command-runner.mjs";

const requiredEnv = [
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_TOKEN_SECRET",
];

const requiredCommands = [
  { name: "yt-dlp", requiredFor: "候補収集 (`npm run fetch`)" },
];

const optionalCommands = [
  { name: "ffmpeg", requiredFor: "動画解析・トリム" },
  { name: "ffprobe", requiredFor: "動画解析・トリム" },
  { name: "codex", requiredFor: "返信判定の LLM 補助" },
  { name: "claude", requiredFor: "返信判定 / 動画解析" },
];

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

function checkEnv() {
  printSection("環境変数");
  let ok = true;

  for (const key of requiredEnv) {
    const exists = Boolean(process.env[key]);
    console.log(`${exists ? "OK " : "NG "} ${key}`);
    if (!exists) ok = false;
  }

  return ok;
}

function checkCommands(items, label) {
  printSection(label);
  let ok = true;

  for (const item of items) {
    const exists = commandExists(item.name);
    console.log(`${exists ? "OK " : "NG "} ${item.name}  ${item.requiredFor}`);
    if (!exists) ok = false;
  }

  return ok;
}

function main() {
  console.log("dashcam-permission doctor");
  console.log(`OS: ${process.platform}`);

  const envOk = checkEnv();
  const requiredOk = checkCommands(requiredCommands, "必須コマンド");
  checkCommands(optionalCommands, "任意コマンド");

  console.log("");
  if (envOk && requiredOk) {
    console.log("必須項目は揃っています。");
    process.exit(0);
  }

  console.log("不足があります。.env と外部コマンドを確認してください。");
  process.exit(1);
}

main();
