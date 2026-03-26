import { TwitterApi } from "twitter-api-v2";
import "dotenv/config";

const client = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

export const twitterClient = client;
export const roClient = client.readOnly;
