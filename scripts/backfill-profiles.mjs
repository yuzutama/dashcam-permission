#!/usr/bin/env node

import db from "../lib/db.mjs";
import { roClient } from "../lib/twitter-client.mjs";

const targets = db.prepare(`
  SELECT DISTINCT username
  FROM targets
  WHERE COALESCE(display_name, '') = ''
     OR COALESCE(profile_image_url, '') = ''
     OR COALESCE(profile_description, '') = ''
  ORDER BY id DESC
`).all();

if (targets.length === 0) {
  console.log("更新対象はありません");
  process.exit(0);
}

const updateStmt = db.prepare(`
  UPDATE targets
  SET display_name = ?,
      profile_image_url = ?,
      profile_description = ?
  WHERE username = ?
`);

let updated = 0;

for (const { username } of targets) {
  try {
    const user = await roClient.v2.userByUsername(username, {
      "user.fields": ["name", "description", "profile_image_url"],
    });
    if (!user.data) {
      console.log(`スキップ: @${username} は取得不可`);
      continue;
    }

    updateStmt.run(
      user.data.name || username,
      user.data.profile_image_url || "",
      user.data.description || "",
      username
    );
    updated++;
    console.log(`更新: @${username}`);
  } catch (error) {
    console.log(`失敗: @${username} - ${error.message}`);
  }
}

console.log(`完了: ${updated} アカウント更新`);
