#!/usr/bin/env node
/**
 * DBでチェック済みの行に対して許可申請リプライを送信するスクリプト
 */

import { twitterClient } from "../lib/twitter-client.mjs";
import db from "../lib/db.mjs";
import { getDashboardSettings } from "../lib/app-settings.mjs";
import { generateReplyText } from "../lib/templates.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const settings = getDashboardSettings();
  const sendIntervalMs = settings.sendIntervalMinutes * 60 * 1000;

  console.log("=== 許可申請リプライ送信 ===\n");

  // send_check=1 & status="未送信" の行を取得
  const targets = db
    .prepare("SELECT * FROM targets WHERE send_check = 1 AND status = '未送信'")
    .all();

  console.log(`送信対象: ${targets.length} 件`);

  if (targets.length === 0) {
    console.log("チェック済み & 未送信の行がありません");
    return;
  }

  // 本日の送信数チェック
  const today = new Date().toISOString().split("T")[0];
  const todaySent = db
    .prepare("SELECT COUNT(*) as cnt FROM targets WHERE status = '送信済み' AND reply_date LIKE ?")
    .get(`${today}%`).cnt;

  if (todaySent >= settings.dailySendLimit) {
    console.log(`本日の送信上限（${settings.dailySendLimit}件）に達しています`);
    return;
  }

  const remaining = settings.dailySendLimit - todaySent;
  const toSend = targets.slice(0, remaining);
  console.log(`本日送信可能: ${remaining} 件 → ${toSend.length} 件送信予定\n`);

  const updateStmt = db.prepare(
    "UPDATE targets SET status = ?, reply_tweet_id = ?, reply_date = ? WHERE id = ?"
  );

  for (let i = 0; i < toSend.length; i++) {
    const target = toSend[i];
    const replyText = generateReplyText();

    console.log(`[${i + 1}/${toSend.length}] @${target.username} へリプライ送信中...`);
    console.log(`  元ツイート: ${target.tweet_url}`);
    console.log(`  文面: ${replyText.replace(/\n/g, " ")}`);

    try {
      const result = await twitterClient.v2.reply(replyText, target.tweet_id);
      const replyTweetId = result.data.id;

      console.log(`  送信成功！ リプライID: ${replyTweetId}`);

      updateStmt.run("送信済み", replyTweetId, new Date().toISOString(), target.id);

      if (i < toSend.length - 1) {
        const waitMin = sendIntervalMs / 60000;
        console.log(`  → ${waitMin}分待機中...\n`);
        await sleep(sendIntervalMs);
      }
    } catch (error) {
      console.error(`  送信エラー: ${error.message}`);
      updateStmt.run("エラー", null, null, target.id);
    }
  }

  console.log(`\n=== 完了: ${toSend.length} 件の送信処理が終了 ===`);
}

main().catch(console.error);
