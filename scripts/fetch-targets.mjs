#!/usr/bin/env node
/**
 * 競合アカウントのリプライを取得し、動画付き元ツイートを
 * ローカルDB + ローカル動画保存するスクリプト
 */

import { roClient } from "../lib/twitter-client.mjs";
import db from "../lib/db.mjs";
import { getDashboardSettings } from "../lib/app-settings.mjs";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIDEOS_DIR = resolve(__dirname, "../data/videos");

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO targets (username, display_name, profile_image_url, profile_description, tweet_url, tweet_id, video_path, post_date, source, tweet_text)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

async function fetchCompetitorReplies(username, startDate, settings) {
  const user = await roClient.v2.userByUsername(username);
  if (!user.data) {
    console.log(`  @${username} が見つかりません`);
    return [];
  }
  const userId = user.data.id;
  console.log(`  @${username} (ID: ${userId})`);

  // Step 1: ページネーションで全リプライを取得し、リプライ先ツイートIDを収集
  const replyToIds = new Map(); // tweetId -> source tweet info
  let pageCount = 0;
  let paginationToken;

  do {
    const params = {
      max_results: 100,
      start_time: startDate.toISOString(),
      "tweet.fields": ["referenced_tweets"],
    };
    if (paginationToken) params.pagination_token = paginationToken;

    const page = await roClient.v2.userTimeline(userId, params);
    const data = page.data?.data || [];
    pageCount++;

    for (const tweet of data) {
      const ref = tweet.referenced_tweets?.find((r) => r.type === "replied_to");
      if (ref) replyToIds.set(ref.id, true);
    }

    paginationToken = page.data?.meta?.next_token;
    console.log(`  ページ${pageCount}: ${data.length}件取得 (リプライ先累計: ${replyToIds.size}件)`);
  } while (paginationToken);

  console.log(`  リプライ先ツイート合計: ${replyToIds.size} 件`);

  // Step 2: リプライ先ツイートをバッチ取得（100件/リクエスト）して動画判定
  const tweetIds = [...replyToIds.keys()];
  const replies = [];

  for (let i = 0; i < tweetIds.length; i += 100) {
    const batch = tweetIds.slice(i, i + 100);
    const lookup = await roClient.v2.tweets(batch, {
      "tweet.fields": ["created_at", "author_id", "text", "attachments"],
      expansions: ["attachments.media_keys", "author_id"],
      "media.fields": ["type"],
      "user.fields": ["username", "name", "description", "profile_image_url"],
    });

    const tweetsData = lookup.data || [];
    const includes = lookup.includes || {};
    const media = includes.media || [];
    const users = includes.users || [];

    for (const tweet of tweetsData) {
      const mediaKeys = tweet.attachments?.media_keys || [];
      const hasVideo = mediaKeys.some((key) => {
        const m = media.find((x) => x.media_key === key);
        return m && (m.type === "video" || (settings.includeAnimatedGif && m.type === "animated_gif"));
      });
      if (!hasVideo) continue;

      const author = users.find((u) => u.id === tweet.author_id);
      const authorUsername = author?.username || tweet.author_id;

      replies.push({
        username: authorUsername,
        displayName: author?.name || authorUsername,
        profileImageUrl: author?.profile_image_url || "",
        profileDescription: author?.description || "",
        tweetUrl: `https://x.com/${authorUsername}/status/${tweet.id}`,
        tweetId: tweet.id,
        tweetText: tweet.text || "",
        postDate: tweet.created_at || "",
        source: username,
      });
    }

    console.log(`  バッチ${Math.floor(i / 100) + 1}: ${batch.length}件照会 → 動画${replies.length}件`);
  }

  return replies;
}

function downloadVideo(tweetUrl, tweetId) {
  const outputPath = resolve(VIDEOS_DIR, `${tweetId}.mp4`);
  if (existsSync(outputPath)) {
    console.log(`    動画キャッシュあり: ${tweetId}`);
    return outputPath;
  }

  try {
    execSync(
      `yt-dlp -o "${outputPath}" --no-warnings "${tweetUrl}"`,
      { stdio: "pipe", timeout: 120000 }
    );
    console.log(`    動画DL完了: ${tweetId}`);
    return outputPath;
  } catch (e) {
    console.error(`    動画DL失敗: ${tweetUrl} - ${e.message}`);
    return null;
  }
}

async function main() {
  const settings = getDashboardSettings();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - settings.crawlDays);

  console.log("=== ドラレコ許可取りターゲット取得 ===\n");
  console.log(`検索期間: ${startDate.toISOString().split("T")[0]} 〜 今日\n`);
  console.log(`監視アカウント: ${settings.monitorAccounts.map((a) => `@${a.username}`).join(", ")}\n`);

  const blockedUsers = new Set(
    db.prepare("SELECT username FROM blocked_users").all().map((r) => r.username)
  );
  const existing = new Set(
    db.prepare("SELECT tweet_url FROM targets").all().map((r) => r.tweet_url)
  );
  console.log(`既存レコード: ${existing.size} 件\n`);
  console.log(`ブロック中アカウント: ${blockedUsers.size} 件\n`);

  let addedCount = 0;

  for (const account of settings.monitorAccounts) {
    console.log(`\n--- @${account.username} (${account.label}) ---`);
    try {
      const replies = await fetchCompetitorReplies(account.username, startDate, settings);
      console.log(`  リプライ先動画投稿: ${replies.length} 件`);

      for (const reply of replies) {
        if (blockedUsers.has(reply.username)) {
          console.log(`  スキップ（ブロック済み）: @${reply.username}`);
          continue;
        }

        if (existing.has(reply.tweetUrl)) {
          console.log(`  スキップ（重複）: ${reply.tweetUrl}`);
          continue;
        }

        console.log(`\n  処理中: @${reply.username} - ${reply.tweetUrl}`);
        const videoPath = downloadVideo(reply.tweetUrl, reply.tweetId);
        if (!videoPath) continue;

        const relPath = `videos/${reply.tweetId}.mp4`;
        const postDateStr = reply.postDate
          ? new Date(reply.postDate).toLocaleDateString("ja-JP")
          : "";

        insertStmt.run(
          reply.username,
          reply.displayName,
          reply.profileImageUrl,
          reply.profileDescription,
          reply.tweetUrl,
          reply.tweetId,
          relPath,
          postDateStr,
          reply.source,
          reply.tweetText
        );
        addedCount++;
      }
    } catch (error) {
      console.error(`  エラー: ${error.message}`);
      if (error.code === 429) {
        console.error("  レート制限。しばらく待ってから再試行してください。");
        break;
      }
    }
  }

  console.log(`\n=== 完了: ${addedCount} 件の新規ターゲットを追加 ===`);
}

main().catch(console.error);
