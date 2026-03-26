#!/usr/bin/env node
/**
 * 手動送信したリプライの tweet ID を、直近の自分の返信から補完する。
 */

import db from "../lib/db.mjs";
import { extractReplyTweetId, fetchOwnRecentReplies, getRepliedToId } from "../lib/reply-tweet-id.mjs";

async function main() {
  const manualId = extractReplyTweetId(process.argv[2]);
  if (process.argv[2] && !manualId) {
    console.error("引数は返信ツイートのURLか数値IDで指定してください");
    process.exit(1);
  }

  console.log("=== reply_tweet_id 補完 ===\n");

  if (manualId) {
    const targetId = process.argv[3];
    if (!targetId) {
      console.error("手動指定モードでは 2つ目の引数に target id が必要です");
      process.exit(1);
    }
    const result = db.prepare(
      "UPDATE targets SET reply_tweet_id = ?, status = '送信済み', reply_date = COALESCE(reply_date, ?) WHERE id = ?"
    ).run(manualId, new Date().toISOString(), targetId);
    console.log(result.changes ? `target ${targetId} に ${manualId} を保存しました` : `target ${targetId} が見つかりません`);
    return;
  }

  const targets = db.prepare(
    "SELECT id, username, tweet_id, reply_date FROM targets WHERE status = '送信済み' AND reply_status = '-' AND reply_tweet_id IS NULL ORDER BY reply_date DESC, id DESC"
  ).all();

  console.log(`補完候補: ${targets.length} 件`);

  if (targets.length === 0) {
    console.log("補完が必要な行はありません");
    return;
  }

  const ownReplies = await fetchOwnRecentReplies(Math.min(targets.length * 3, 100));
  console.log(`取得した自分の返信: ${ownReplies.length} 件`);

  const usedIds = new Set();
  const updateStmt = db.prepare("UPDATE targets SET reply_tweet_id = ? WHERE id = ?");

  let matched = 0;
  for (const target of targets) {
    const candidates = ownReplies
      .filter((tweet) => !usedIds.has(tweet.id))
      .filter((tweet) => getRepliedToId(tweet) === String(target.tweet_id))
      .sort((a, b) => {
        const ta = new Date(a.created_at || 0).getTime();
        const tb = new Date(b.created_at || 0).getTime();
        return tb - ta;
      });

    const match = candidates[0];
    if (!match) continue;

    updateStmt.run(match.id, target.id);
    usedIds.add(match.id);
    matched++;
    console.log(`@${target.username}: ${match.id} を補完`);
  }

  console.log(`\n完了: ${matched}/${targets.length} 件を補完`);
}

main().catch((error) => {
  console.error("補完エラー:", error.message);
  process.exit(1);
});
