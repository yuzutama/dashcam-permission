import { twitterClient } from "./twitter-client.mjs";

export function extractReplyTweetId(input) {
  const value = (input || "").trim();
  if (!value) return null;

  const statusMatch = value.match(/status\/(\d+)/);
  if (statusMatch) return statusMatch[1];

  return /^\d+$/.test(value) ? value : null;
}

export function getRepliedToId(tweet) {
  const refs = tweet.referenced_tweets || [];
  const replied = refs.find((ref) => ref.type === "replied_to");
  return replied?.id || null;
}

export async function fetchOwnRecentReplies(limit = 100) {
  const me = await twitterClient.v2.me();
  const timeline = await twitterClient.v2.userTimeline(me.data.id, {
    max_results: Math.min(Math.max(limit, 5), 100),
    exclude: ["retweets"],
    "tweet.fields": ["author_id", "conversation_id", "created_at", "referenced_tweets", "text"],
  });

  const tweets = timeline.tweets || timeline.data?.data || [];
  return tweets.filter((tweet) => getRepliedToId(tweet));
}

export async function findOwnRecentReplyToTweet(tweetId, limit = 40) {
  const ownReplies = await fetchOwnRecentReplies(limit);
  const candidates = ownReplies
    .filter((tweet) => getRepliedToId(tweet) === String(tweetId))
    .sort((a, b) => {
      const ta = new Date(a.created_at || 0).getTime();
      const tb = new Date(b.created_at || 0).getTime();
      return tb - ta;
    });

  return candidates[0] || null;
}
