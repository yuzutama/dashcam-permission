#!/usr/bin/env node
/**
 * 送信済みリプライへの返信を監視し、DBのステータスを更新するスクリプト
 */

import { execSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { roClient } from "../lib/twitter-client.mjs";
import db from "../lib/db.mjs";
import { getDashboardSettings } from "../lib/app-settings.mjs";
import { runCommand } from "../lib/command-runner.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PERMIT_KEYWORDS = ["どうぞ", "大丈夫", "構いません", "問題ない", "OK", "ok", "いいですよ", "使ってください", "許可", "ぜひ"];
const DENY_KEYWORDS = ["お断り", "遠慮", "NG", "無理", "できません", "やめて", "困り", "不可"];

function classifyReply(text) {
  if (PERMIT_KEYWORDS.some((kw) => text.includes(kw))) return "許可";
  if (DENY_KEYWORDS.some((kw) => text.includes(kw))) return "拒否";
  return "返信あり";
}

function normalizeLabel(label) {
  const trimmed = (label || "").trim();
  if (trimmed === "許可" || trimmed === "拒否" || trimmed === "返信あり" || trimmed === "判定不可") return trimmed;
  return null;
}

const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

function classifyWithCodex(text) {
  const tempDir = mkdtempSync(resolve(tmpdir(), "dashcam-codex-"));
  const outputPath = resolve(tempDir, "result.txt");
  const prompt = [
    "次の返信文を、以下の4分類のいずれか1語だけで判定してください。",
    "許可: 使用許可・了承・前向きな承認。",
    "拒否: 使用拒否・断り・消極的な拒絶。",
    "返信あり: どちらとも断定できない返信、質問、雑談、保留。",
    "判定不可: 文脈不足や表現の曖昧さで分類できない。",
    "出力は必ず次のいずれか1語のみ: 許可 / 拒否 / 返信あり / 判定不可",
    "",
    `返信文: ${text}`,
  ].join("\n");

  try {
    runCommand(CODEX_BIN, [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-o",
      outputPath,
      prompt,
    ], {
      stdio: "pipe",
      timeout: 120000,
    });
    return normalizeLabel(readFileSync(outputPath, "utf8"));
  } catch (error) {
    return null;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function classifyWithClaude(text) {
  const prompt = [
    "次の返信文を 許可 / 拒否 / 返信あり / 判定不可 のいずれか1語で分類してください。",
    "許可以外の余計な文字は出力しないでください。",
    "",
    `返信文: ${text}`,
  ].join("\n");

  try {
    const result = runCommand(CLAUDE_BIN, ["-p", prompt], {
      stdio: "pipe",
      timeout: 120000,
    });
    return normalizeLabel(result.stdout);
  } catch (error) {
    return null;
  }
}

function classifyReplySmart(text) {
  const settings = getDashboardSettings();

  if (settings.replyClassifierMode === "keyword-only") {
    const keywordLabel = classifyReply(text);
    return keywordLabel === "返信あり"
      ? { label: "判定不可", method: "fallback" }
      : { label: keywordLabel, method: "keyword" };
  }

  if (settings.replyClassifierMode === "claude-first") {
    const claudeLabel = classifyWithClaude(text);
    if (claudeLabel) return { label: claudeLabel, method: "claude" };

    const codexLabel = classifyWithCodex(text);
    if (codexLabel) return { label: codexLabel, method: "codex" };
  } else {
    const codexLabel = classifyWithCodex(text);
    if (codexLabel) return { label: codexLabel, method: "codex" };

    const claudeLabel = classifyWithClaude(text);
    if (claudeLabel) return { label: claudeLabel, method: "claude" };
  }

  if (settings.replyClassifierMode === "llm-only") {
    return { label: "判定不可", method: "llm-unavailable" };
  }

  const keywordLabel = classifyReply(text);
  return keywordLabel === "返信あり"
    ? { label: "判定不可", method: "fallback" }
    : { label: keywordLabel, method: "keyword" };
}

async function main() {
  const settings = getDashboardSettings();
  console.log("=== 返信モニター ===\n");

  const targets = db
    .prepare("SELECT * FROM targets WHERE status = '送信済み' AND reply_status = '-' AND reply_tweet_id IS NOT NULL")
    .all();

  console.log(`チェック対象: ${targets.length} 件\n`);

  if (targets.length === 0) {
    console.log("チェック対象の行がありません");
    return;
  }

  const updateStmt = db.prepare(
    "UPDATE targets SET reply_status = ?, reply_date = ?, received_reply_text = ? WHERE id = ?"
  );

  let updatedCount = 0;

  for (const target of targets) {
    console.log(`チェック中: @${target.username} (リプライID: ${target.reply_tweet_id})`);

    try {
      const searchResult = await roClient.v2.search(
        `conversation_id:${target.reply_tweet_id} is:reply`,
        {
          max_results: 10,
          "tweet.fields": ["author_id", "text", "created_at"],
        }
      );

      const replies = searchResult.data?.data || [];

      if (replies.length === 0) {
        console.log(`  → 返信なし`);
        continue;
      }

      const firstReply = replies[0];
      const { label: classification, method } = classifyReplySmart(firstReply.text);
      const detectedDate = new Date().toLocaleDateString("ja-JP");

      console.log(`  → ${classification} [${method}]: "${firstReply.text.substring(0, 80)}"`);

      updateStmt.run(classification, detectedDate, firstReply.text, target.id);
      updatedCount++;
    } catch (error) {
      console.error(`  エラー: ${error.message}`);
    }
  }

  console.log(`\n=== 完了: ${updatedCount} 件の返信を検出 ===`);

  // 許可が検出された場合、自動で動画解析を実行
  const permitted = db.prepare(
    "SELECT COUNT(*) as cnt FROM targets WHERE reply_status = '許可' AND category IS NULL AND video_path IS NOT NULL"
  ).get();

  if (settings.autoAnalyzePermitted && permitted.cnt > 0) {
    console.log(`\n許可済み未解析: ${permitted.cnt} 件 → 自動解析を開始`);
    try {
      const analyzeScript = resolve(__dirname, "analyze-videos.mjs");
      execSync(`node "${analyzeScript}"`, { stdio: "inherit" });
    } catch (error) {
      console.error("解析エラー:", error.message);
    }
  } else if (!settings.autoAnalyzePermitted && permitted.cnt > 0) {
    console.log(`\n許可済み未解析: ${permitted.cnt} 件ありますが、自動解析は設定で無効です`);
  }
}

main().catch(console.error);
