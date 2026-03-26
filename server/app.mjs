import express from "express";
import db from "../lib/db.mjs";
import { PORT } from "../lib/constants.mjs";
import { getDashboardSettings, saveDashboardSettings } from "../lib/app-settings.mjs";
import { twitterClient } from "../lib/twitter-client.mjs";
import { generateReplyText } from "../lib/templates.mjs";
import { execFileSync } from "child_process";
import { extractReplyTweetId, findOwnRecentReplyToTweet } from "../lib/reply-tweet-id.mjs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");
const TRIMMED_DIR = resolve(DATA_DIR, "trimmed");
const PROJECTS_DIR = resolve(DATA_DIR, "projects");

const app = express();
app.use(express.json());

function getVideoDuration(videoPath) {
  const fullPath = resolve(DATA_DIR, videoPath);
  const result = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    fullPath,
  ], { encoding: "utf8" }).trim();
  return parseFloat(result);
}

function buildTrimMetadata(target, trimmedVideoPath) {
  return {
    id: target.id,
    username: target.username,
    tweet_url: target.tweet_url,
    tweet_id: target.tweet_id,
    tweet_text: target.tweet_text || "",
    post_date: target.post_date || "",
    source: target.source,
    reply_status: target.reply_status,
    reply_date: target.reply_date,
    category: target.category || "",
    location: target.location || "",
    weather: target.weather || "",
    danger_level: target.danger_level || "",
    trim_start: target.trim_start ?? 0,
    trim_end: target.trim_end ?? null,
    trimmed_video_file: trimmedVideoPath.split("/").pop(),
    trimmed_at: new Date().toISOString(),
  };
}

function buildCommentaryTemplate(target) {
  return `# 素材: ${target.username}_${target.tweet_id}

## 基本情報
- 投稿者: @${target.username}
- 元投稿: ${target.tweet_url}
- 動画: ${target.trimmed_video_path ? basename(target.trimmed_video_path) : ""}
- カテゴリ: ${target.category || ""}
- 場所: ${target.location || ""}
- 天候: ${target.weather || ""}
- 危険度: ${target.danger_level || ""}

## 何が起きているか

## 時系列
- 

## コメント案
1. 
2. 
3. 

## 採用コメント

## 修正メモ
- 
`;
}

function writeCommentaryFiles(target, outDir) {
  const commentaryJson = {
    asset_id: `${target.username}_${target.tweet_id}`,
    video_file: target.trimmed_video_path ? basename(target.trimmed_video_path) : "",
    scene_summary: "",
    event_timeline: [],
    comment_drafts: [],
    selected_comment: target.selected_comment || "",
    revision_notes: target.editor_note || "",
  };
  writeFileSync(resolve(outDir, "commentary.json"), JSON.stringify(commentaryJson, null, 2), "utf8");
  writeFileSync(resolve(outDir, "commentary.md"), buildCommentaryTemplate(target), "utf8");
}

function nextProjectCode() {
  const today = new Date();
  const y = String(today.getFullYear());
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const prefix = `P${y}${m}${d}`;
  const row = db.prepare("SELECT project_code FROM projects WHERE project_code LIKE ? ORDER BY project_code DESC LIMIT 1").get(`${prefix}-%`);
  const nextNumber = row ? Number(row.project_code.split("-").pop()) + 1 : 1;
  return `${prefix}-${String(nextNumber).padStart(2, "0")}`;
}

function ensureProjectDir(projectCode) {
  const dir = resolve(PROJECTS_DIR, projectCode);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function moveTrimmedAssetToProject(target, project) {
  if (!target.trimmed_video_path) throw new Error("トリム済み素材がありません");

  const assetFolderName = target.trimmed_video_path.split("/").slice(1, 2)[0];
  if (!assetFolderName) throw new Error("素材フォルダ名を解決できません");

  const currentAssetDir = target.project_id
    ? resolve(PROJECTS_DIR, project.project_code, assetFolderName)
    : resolve(TRIMMED_DIR, assetFolderName);
  const targetProjectDir = ensureProjectDir(project.project_code);
  const nextAssetDir = resolve(targetProjectDir, assetFolderName);

  if (!existsSync(currentAssetDir)) throw new Error("移動元の素材フォルダが見つかりません");
  if (!existsSync(nextAssetDir)) {
    renameSync(currentAssetDir, nextAssetDir);
  }

  const trimmedFileName = basename(target.trimmed_video_path);
  const relativeTrimmedPath = `project-files/${project.project_code}/${assetFolderName}/${trimmedFileName}`;
  const commentaryPath = `project-files/${project.project_code}/${assetFolderName}/commentary.md`;
  const metadataPath = resolve(nextAssetDir, "metadata.json");

  db.prepare(`
    UPDATE targets
    SET project_id = ?, asset_status = 'project_assigned', trimmed_video_path = ?, selected_comment = COALESCE(selected_comment, ''), editor_note = COALESCE(editor_note, '')
    WHERE id = ?
  `).run(project.id, relativeTrimmedPath, target.id);

  const refreshed = db.prepare("SELECT * FROM targets WHERE id = ?").get(target.id);
  if (!existsSync(resolve(nextAssetDir, "commentary.md"))) {
    writeCommentaryFiles(refreshed, nextAssetDir);
  }
  if (existsSync(metadataPath)) {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    metadata.trimmed_video_file = trimmedFileName;
    metadata.project_code = project.project_code;
    metadata.commentary_file = "commentary.md";
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
  }

  return { relativeTrimmedPath, commentaryPath };
}

function exportTrimmedVideo(target) {
  if (!target.video_path) throw new Error("動画パスがありません");

  const sourcePath = resolve(DATA_DIR, target.video_path);
  if (!existsSync(sourcePath)) throw new Error("元動画が見つかりません");

  const duration = getVideoDuration(target.video_path);
  const start = Math.max(0, Number(target.trim_start ?? 0));
  const rawEnd = target.trim_end == null ? duration : Number(target.trim_end);
  const end = Math.min(duration, rawEnd);

  if (!(end > start)) throw new Error("トリム終了位置は開始位置より後にしてください");

  const dirName = `${target.username}_${target.tweet_id}`;
  const outDir = resolve(TRIMMED_DIR, dirName);
  const outFile = `${target.tweet_id}_trimmed.mp4`;
  const outPath = resolve(outDir, outFile);
  const relativeVideoPath = `trimmed/${dirName}/${outFile}`;

  mkdirSync(outDir, { recursive: true });
  execFileSync("ffmpeg", [
    "-y",
    "-i", sourcePath,
    "-ss", start.toFixed(2),
    "-to", end.toFixed(2),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    outPath,
  ], { stdio: "ignore" });

  const refreshedTarget = db.prepare("SELECT * FROM targets WHERE id = ?").get(target.id);
  const metadata = buildTrimMetadata(refreshedTarget, relativeVideoPath);
  writeFileSync(resolve(outDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");

  db.prepare("UPDATE targets SET trimmed_video_path = ?, trimmed_at = ?, asset_status = 'trimmed' WHERE id = ?")
    .run(relativeVideoPath, metadata.trimmed_at, target.id);

  if (!existsSync(resolve(outDir, "commentary.md"))) {
    const refreshed = db.prepare("SELECT * FROM targets WHERE id = ?").get(target.id);
    writeCommentaryFiles(refreshed, outDir);
  }

  return { relativeVideoPath, trimmedAt: metadata.trimmed_at };
}

// 動画ファイル配信
app.use("/videos", express.static(resolve(DATA_DIR, "videos")));
app.use("/trimmed", express.static(resolve(DATA_DIR, "trimmed")));
app.use("/project-files", express.static(resolve(DATA_DIR, "projects")));

// 管理画面
app.get("/", (req, res) => {
  const tab = req.query.tab || "未送信";
  const settings = getDashboardSettings();
  const all = db.prepare("SELECT * FROM targets ORDER BY id DESC").all();
  const projects = db.prepare("SELECT * FROM projects ORDER BY id DESC").all();
  const blockedUsers = new Set(
    db.prepare("SELECT username FROM blocked_users").all().map((r) => r.username)
  );
  const blockedTargets = all.filter((t) => blockedUsers.has(t.username));
  const visibleTargets = all.filter((t) => !blockedUsers.has(t.username));
  const counts = { "未送信": 0, "送信済み": 0, "許可済み": 0, "トリム済み": 0, "拒否": 0, "スキップ": 0, "ブロック": blockedTargets.length, "設定": 1 };
  visibleTargets.forEach(t => {
    if (t.asset_status === "trimmed") counts["トリム済み"]++;
    if (t.reply_status === "許可" && !t.trimmed_video_path) counts["許可済み"]++;
    else if (t.reply_status === "拒否") counts["拒否"]++;
    else if (t.status === "送信待ち") counts["送信済み"]++;
    else if (t.status === "エラー") counts["未送信"]++;
    else if (counts[t.status] !== undefined) counts[t.status]++;
  });
  let targets;
  if (tab === "ブロック") targets = blockedTargets;
  else if (tab === "トリム済み") targets = visibleTargets.filter(t => t.asset_status === "trimmed");
  else if (tab === "許可済み") targets = visibleTargets.filter(t => t.reply_status === "許可" && !t.trimmed_video_path);
  else if (tab === "拒否") targets = visibleTargets.filter(t => t.reply_status === "拒否");
  else if (tab === "送信済み") targets = visibleTargets.filter(t => (t.status === "送信済み" || t.status === "送信待ち") && t.reply_status !== "許可" && t.reply_status !== "拒否");
  else if (tab === "未送信") targets = visibleTargets.filter(t => (t.status === "未送信" || t.status === "エラー") && t.reply_status !== "許可" && t.reply_status !== "拒否");
  else if (tab === "設定") targets = [];
  else targets = visibleTargets.filter(t => t.status === tab && t.reply_status !== "許可" && t.reply_status !== "拒否");
  res.send(renderPage(targets, tab, counts, settings, projects));
});

// リプライ文面生成API
app.get("/api/reply-text", (req, res) => {
  res.json({ text: generateReplyText() });
});

// メタデータ取得API
app.get("/api/metadata/:id", (req, res) => {
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "not found" });
  res.json({
    category: target.category || "",
    trim_start: target.trim_start ?? null,
    trim_end: target.trim_end ?? null,
    location: target.location || "",
    weather: target.weather || "",
    danger_level: target.danger_level || "",
    trimmed_video_path: target.trimmed_video_path || "",
    trimmed_at: target.trimmed_at || null,
  });
});

// メタデータ保存API
app.post("/api/metadata/:id", (req, res) => {
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "not found" });
  const { category, trim_start, trim_end, location, weather, danger_level } = req.body;
  db.prepare(
    "UPDATE targets SET category = ?, trim_start = ?, trim_end = ?, location = ?, weather = ?, danger_level = ? WHERE id = ?"
  ).run(
    category || null,
    trim_start ?? null,
    trim_end ?? null,
    location || null,
    weather || null,
    danger_level || null,
    req.params.id
  );
  res.json({ ok: true });
});

app.post("/api/trim/:id", (req, res) => {
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "not found" });

  try {
    const inputTrimStart = req.body?.trim_start;
    const inputTrimEnd = req.body?.trim_end;
    db.prepare("UPDATE targets SET trim_start = ?, trim_end = ? WHERE id = ?").run(
      inputTrimStart ?? target.trim_start ?? null,
      inputTrimEnd ?? target.trim_end ?? null,
      target.id
    );
    const refreshed = db.prepare("SELECT * FROM targets WHERE id = ?").get(req.params.id);
    const result = exportTrimmedVideo(refreshed);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ステータス変更API
app.post("/api/status/:id", async (req, res) => {
  const { status, reply_tweet_id } = req.body;
  const allowed = ["未送信", "送信済み", "送信待ち", "スキップ", "エラー"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "invalid status" });
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "not found" });
  const replyDate = status === "送信済み" ? new Date().toISOString() : null;
  const parsedReplyTweetId = typeof reply_tweet_id === "string" ? extractReplyTweetId(reply_tweet_id) : null;
  if (typeof reply_tweet_id === "string" && reply_tweet_id.trim() && !parsedReplyTweetId) {
    return res.status(400).json({ error: "invalid reply_tweet_id" });
  }
  let detectedReplyTweetId = parsedReplyTweetId;
  let message = "";
  if (status === "送信済み" && !detectedReplyTweetId) {
    try {
      const replyTweet = await findOwnRecentReplyToTweet(target.tweet_id, 40);
      detectedReplyTweetId = replyTweet?.id || null;
      message = detectedReplyTweetId
        ? "送信済みにしました。返信IDもAPIから取得しました"
        : "送信済みにしました。返信IDはAPIで見つかりませんでした";
    } catch (error) {
      message = `送信済みにしました。返信IDの取得に失敗しました: ${error.message}`;
    }
  }
  db.prepare("UPDATE targets SET status = ?, reply_tweet_id = COALESCE(?, reply_tweet_id), reply_date = ? WHERE id = ?")
    .run(status, detectedReplyTweetId, replyDate, target.id);
  res.json({ ok: true, reply_tweet_id: detectedReplyTweetId, message });
});

// 返信ステータス変更API（OK/NG）
app.post("/api/reply-status/:id", (req, res) => {
  const { reply_status } = req.body;
  const allowed = ["-", "許可", "拒否", "返信あり", "判定不可"];
  if (!allowed.includes(reply_status)) return res.status(400).json({ error: "invalid" });
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "not found" });
  db.prepare("UPDATE targets SET reply_status = ?, reply_date = ? WHERE id = ?")
    .run(reply_status, new Date().toISOString(), target.id);
  res.json({ ok: true });
});

app.post("/api/block-user/:username", (req, res) => {
  const username = req.params.username;
  const target = db.prepare("SELECT username FROM targets WHERE username = ? LIMIT 1").get(username);
  if (!target) return res.status(404).json({ error: "not found" });
  db.prepare("INSERT OR IGNORE INTO blocked_users (username) VALUES (?)").run(username);
  res.json({ ok: true });
});

app.post("/api/unblock-user/:username", (req, res) => {
  db.prepare("DELETE FROM blocked_users WHERE username = ?").run(req.params.username);
  res.json({ ok: true });
});

app.get("/api/settings", (req, res) => {
  res.json(getDashboardSettings());
});

app.post("/api/settings", (req, res) => {
  const { monitorAccounts, crawlDays } = req.body;
  const settings = saveDashboardSettings({ monitorAccounts, crawlDays });
  res.json({ ok: true, settings });
});

app.get("/projects", (req, res) => {
  const projects = db.prepare(`
    SELECT p.*, COUNT(t.id) AS asset_count
    FROM projects p
    LEFT JOIN targets t ON t.project_id = p.id
    GROUP BY p.id
    ORDER BY p.id DESC
  `).all();
  res.send(renderProjectsPage(projects));
});

app.get("/projects/:id", (req, res) => {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).send("project not found");
  const assets = db.prepare("SELECT * FROM targets WHERE project_id = ? ORDER BY sort_order IS NULL, sort_order, id DESC").all(project.id);
  res.send(renderProjectDetailPage(project, assets));
});

app.post("/api/projects", (req, res) => {
  const title = (req.body?.title || "").trim() || "新規プロジェクト";
  const projectCode = nextProjectCode();
  const result = db.prepare("INSERT INTO projects (project_code, title) VALUES (?, ?)").run(projectCode, title);
  ensureProjectDir(projectCode);
  res.json({ ok: true, id: result.lastInsertRowid, project_code: projectCode, title });
});

app.post("/api/projects/:id/add-asset", (req, res) => {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project not found" });
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(req.body?.targetId);
  if (!target) return res.status(404).json({ error: "asset not found" });
  try {
    const result = moveTrimmedAssetToProject(target, project);
    db.prepare("UPDATE projects SET updated_at = datetime('now', 'localtime') WHERE id = ?").run(project.id);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// === 送信キュー ===
const sendQueue = [];
let queueRunning = false;

async function processQueue() {
  if (queueRunning || sendQueue.length === 0) return;
  queueRunning = true;

  while (sendQueue.length > 0) {
    const settings = getDashboardSettings();
    const sendIntervalMs = settings.sendIntervalMinutes * 60 * 1000;
    const item = sendQueue[0];
    console.log(`[キュー] 送信中: @${item.username} (残り${sendQueue.length}件)`);
    try {
      const result = await twitterClient.v2.reply(item.text, item.tweet_id);
      db.prepare("UPDATE targets SET status = '送信済み', reply_tweet_id = ?, reply_date = ? WHERE id = ?")
        .run(result.data.id, new Date().toISOString(), item.id);
      item.status = "sent";
      console.log(`[キュー] 送信成功: @${item.username}`);
    } catch (error) {
      db.prepare("UPDATE targets SET status = 'エラー' WHERE id = ?").run(item.id);
      item.status = "error";
      item.error = error.message;
      console.error(`[キュー] 送信エラー: @${item.username} - ${error.message}`);
    }
    sendQueue.shift();

    if (sendQueue.length > 0) {
      console.log(`[キュー] ${sendIntervalMs / 60000}分待機中...`);
      await new Promise(r => setTimeout(r, sendIntervalMs));
    }
  }
  queueRunning = false;
}

// キューに追加API
app.post("/api/enqueue", (req, res) => {
  const { id, text } = req.body;
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(id);
  if (!target) return res.status(404).json({ error: "not found" });
  if (sendQueue.some(q => q.id === id)) return res.json({ ok: false, message: "既にキューに入っています" });

  sendQueue.push({ id: target.id, tweet_id: target.tweet_id, username: target.username, text, status: "waiting" });
  db.prepare("UPDATE targets SET status = '送信待ち' WHERE id = ?").run(target.id);
  console.log(`[キュー] 追加: @${target.username} (キュー${sendQueue.length}件)`);

  processQueue();
  res.json({ ok: true, position: sendQueue.length });
});

// キュー状態API
app.get("/api/queue", (req, res) => {
  res.json({
    queue: sendQueue.map(q => ({ id: q.id, username: q.username, status: q.status })),
    running: queueRunning,
  });
});

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPage(targets, tab, counts, settings, projects) {
  const projectOptions = projects.map((project) =>
    `<option value="${project.id}">${escapeHtml(project.project_code)} ${project.title ? `| ${escapeHtml(project.title)}` : ""}</option>`
  ).join("");
  const rows = targets
    .map((t) => {
      const statusClass =
        t.status === "未送信" ? "pending" :
        t.status === "送信済み" ? "sent" :
        t.status === "スキップ" ? "skipped" :
        t.status === "エラー" ? "error" : "";
      const replyClass =
        t.reply_status === "許可" ? "permit" :
        t.reply_status === "拒否" ? "deny" :
        t.reply_status === "判定不可" ? "undetermined" :
        t.reply_status === "返信あり" ? "replied" : "";
      const currentVideoPath = tab === "トリム済み" && t.trimmed_video_path ? t.trimmed_video_path : t.video_path;
      const videoFile = currentVideoPath ? resolve(DATA_DIR, currentVideoPath) : null;
      const hasVideo = videoFile && existsSync(videoFile);
      const isUnsent = t.status === "未送信";
      const canInlineTrim = tab === "許可済み" || tab === "トリム済み";
      const tweetText = escapeHtml(t.tweet_text);

      const replyText = escapeHtml(t.reply_text);
      const receivedReplyText = escapeHtml(t.received_reply_text);
      const displayName = escapeHtml(t.display_name || t.username);
      const profileDescription = escapeHtml(t.profile_description);
      const profileImage = t.profile_image_url ? escapeHtml(t.profile_image_url) : "";
      const receivedReplyLabel = t.reply_status === "判定不可" ? "相手の返信（判定できませんでした）" : "相手の返信";
      const actionButton = tab === "ブロック"
        ? `<button class="unblock-user-btn" onclick="unblockUser('${t.username}', this)">ブロック解除</button>`
        : `<button class="block-user-btn" onclick="blockUser('${t.username}', this)">このアカウントを非表示</button>`;

      // 投稿者ヘッダー（共通）
      const infoBlock = `<div class="poster-info">
        ${profileImage ? `<img src="${profileImage}" alt="@${escapeHtml(t.username)}" class="poster-avatar" referrerpolicy="no-referrer">` : `<div class="poster-avatar poster-avatar-fallback">@</div>`}
        <div class="poster-details">
          <div class="poster-line poster-primary">
            <span class="poster-display-name">${displayName}</span>
            <a href="https://x.com/${t.username}" target="_blank" class="poster-handle">@${t.username}</a>
          </div>
          <div class="poster-line poster-secondary">
            <span class="meta">${t.post_date || "-"}</span>
            <span class="poster-dot">•</span>
            <span class="meta">@${t.source}</span>
            <a href="${t.tweet_url}" target="_blank" class="tweet-link poster-link-btn">ポストを見る</a>
          </div>
          ${profileDescription ? `<div class="poster-bio">${profileDescription}</div>` : ""}
          <div class="poster-actions">
            ${actionButton}
          </div>
        </div>
      </div>`;

      // 未送信タブ
      if (canInlineTrim) {
        return `<tr data-id="${t.id}">
        <td class="video-cell">${hasVideo ? `<video id="video-${t.id}" src="/${currentVideoPath}" class="js-autoplay-video" controls muted loop playsinline preload="metadata"></video>` : "-"}</td>
        <td class="text-cell">
          ${infoBlock}
          ${tweetText ? `<div class="tweet-text">${tweetText}</div>` : ""}
          ${replyText ? `<hr class="divider"><div class="reply-block"><div class="reply-block-label">送信文</div><div class="reply-text-display">${replyText}</div></div>` : ''}
          ${receivedReplyText ? `<div class="reply-block received"><div class="reply-block-label">${receivedReplyLabel}</div><div class="reply-text-display received">${receivedReplyText}</div></div>` : ''}
        </td>
        <td class="action-cell inline-trim-cell">
          <div class="inline-trim-card">
            <div class="inline-trim-row">
              <div>
                <label>開始</label>
                <input id="trim-start-${t.id}" type="number" step="0.1" min="0" value="${t.trim_start ?? ""}" placeholder="0">
              </div>
              <div>
                <label>終了</label>
                <input id="trim-end-${t.id}" type="number" step="0.1" min="0" value="${t.trim_end ?? ""}" placeholder="動画末尾">
              </div>
            </div>
            <div class="inline-trim-actions">
              <button class="trim-point-btn" onclick="setInlineTrimPoint(${t.id}, 'start')">今を開始</button>
              <button class="trim-point-btn" onclick="setInlineTrimPoint(${t.id}, 'end')">今を終了</button>
            </div>
            <button class="trim-save-btn" onclick="saveTrimmedInline(${t.id}, this)">保存してトリム出力</button>
            ${tab === "トリム済み" ? `
            <div class="project-assign-box">
              <select id="project-select-${t.id}" class="project-select">
                <option value="">プロジェクト選択</option>
                ${projectOptions}
              </select>
              <div class="project-assign-actions">
                <button class="project-add-btn" onclick="assignAssetToProject(${t.id})">プロジェクトへ追加</button>
                <button class="project-create-btn" onclick="createProjectAndAssign(${t.id})">新規PJ作成</button>
              </div>
            </div>` : ""}
            ${t.trimmed_video_path ? `<div class="inline-trim-status">保存先: /${t.trimmed_video_path}</div>` : ""}
          </div>
        </td>
        <td>-</td>
      </tr>`;
      }

      if (isUnsent) {
        return `<tr data-id="${t.id}">
          <td class="video-cell">${hasVideo ? `<video id="video-${t.id}" src="/${currentVideoPath}" class="js-autoplay-video" controls muted loop playsinline preload="metadata"></video>` : "-"}</td>
          <td class="text-cell">
            ${infoBlock}
            ${tweetText ? `<div class="tweet-text">${tweetText}</div>` : ""}
            <hr class="divider">
            <textarea class="reply-textarea" id="text-${t.id}">${generateReplyText()}</textarea>
            <div class="text-actions">
              <button class="regen-btn" onclick="regen(${t.id})">再生成</button>
              <a href="#" class="copy-reply-link" onclick="copyAndOpen(${t.id}, '${t.tweet_id}'); return false;">コピーしてTwitterへ</a>
            </div>
          </td>
          <td class="action-cell" id="action-${t.id}">
            <div class="action-group action-group-send">
              <button class="send-btn" onclick="send(${t.id}, this)">送信</button>
              <button class="skip-btn" onclick="skip(${t.id}, this)">スキップ</button>
            </div>
            <div class="action-group action-group-manual">
              <button class="mark-sent-btn" onclick="markSent(${t.id}, this)">送信済みにする</button>
            </div>
            <div class="okng-buttons" id="okng-${t.id}">
              <button class="ok-btn" onclick="setReplyStatus(${t.id}, '許可', this)">許可済み</button>
              <button class="ng-btn" onclick="setReplyStatus(${t.id}, '拒否', this)">拒否</button>
            </div>
          </td>
          <td>${hasVideo ? `<button class="meta-btn${t.category ? ' has-meta' : ''}" onclick="openMeta(${t.id}, '/${t.video_path}')">${t.trimmed_video_path ? 'トリム / メタ' : (t.category || 'トリム / メタ')}</button>` : '-'}</td>
        </tr>`;
      }

      // 送信済み・スキップタブ
      return `<tr data-id="${t.id}">
        <td class="video-cell">${hasVideo ? `<video id="video-${t.id}" src="/${currentVideoPath}" class="js-autoplay-video" controls muted loop playsinline preload="metadata"></video>` : "-"}</td>
        <td class="text-cell">
          ${infoBlock}
          ${tweetText ? `<div class="tweet-text">${tweetText}</div>` : ""}
          ${replyText ? `<hr class="divider"><div class="reply-block"><div class="reply-block-label">送信文</div><div class="reply-text-display">${replyText}</div></div>` : ''}
          ${receivedReplyText ? `<div class="reply-block received"><div class="reply-block-label">${receivedReplyLabel}</div><div class="reply-text-display received">${receivedReplyText}</div></div>` : ''}
          <div style="margin-top:8px;">
            <select class="status-select ${statusClass}" onchange="changeStatus(${t.id}, this.value, this)">
              <option value="未送信" ${t.status === "未送信" ? "selected" : ""}>未送信</option>
              <option value="送信済み" ${t.status === "送信済み" ? "selected" : ""}>送信済み</option>
              <option value="スキップ" ${t.status === "スキップ" ? "selected" : ""}>スキップ</option>
              <option value="エラー" ${t.status === "エラー" ? "selected" : ""}>エラー</option>
            </select>
          </div>
        </td>
        <td class="action-cell">
          <div class="okng-buttons" id="okng-${t.id}">
            <button class="ok-btn${t.reply_status === '許可' ? ' active' : ''}" onclick="setReplyStatus(${t.id}, '許可', this)">許可</button>
            <button class="ng-btn${t.reply_status === '拒否' ? ' active' : ''}" onclick="setReplyStatus(${t.id}, '拒否', this)">拒否</button>
          </div>
          <a href="#" class="tweet-link" onclick="revert(${t.id}); return false;" style="font-size:0.72rem;color:#999;">未送信に戻す</a>
        </td>
        <td>${t.video_path ? `<button class="meta-btn${t.category ? ' has-meta' : ''}" onclick="openMeta(${t.id}, '/${t.video_path}')">${t.trimmed_video_path ? 'トリム / メタ' : (t.category || 'トリム / メタ')}</button>` : '-'}</td>
      </tr>`;
    })
    .join("\n");

  const settingsBody = `
    <div class="settings-board">
      <div class="settings-card">
        <h2>監視設定</h2>
        <p class="settings-help">ここで保存した内容は、次回の <code>npm run fetch</code> から使われます。</p>
        <label for="monitor-accounts">監視アカウント</label>
        <textarea id="monitor-accounts" class="settings-textarea" placeholder="@account,label">${settings.monitorAccounts.map((account) => `@${account.username},${account.label}`).join("\n")}</textarea>
        <p class="settings-help">1行に1アカウント。形式は <code>@username,ラベル</code> です。ラベルは省略可です。</p>
        <label for="crawl-days">取得期間（日数）</label>
        <input id="crawl-days" class="settings-input" type="number" min="1" max="365" value="${settings.crawlDays}">
        <label for="channel-name">チャンネル名</label>
        <input id="channel-name" class="settings-input" type="text" value="${escapeHtml(settings.channelName)}">
        <p class="settings-help">リプライ文面に差し込むチャンネル名です。</p>
        <div class="settings-grid">
          <div>
            <label for="daily-send-limit">1日の送信上限</label>
            <input id="daily-send-limit" class="settings-input" type="number" min="1" max="500" value="${settings.dailySendLimit}">
          </div>
          <div>
            <label for="send-interval-minutes">送信間隔（分）</label>
            <input id="send-interval-minutes" class="settings-input" type="number" min="1" max="1440" value="${settings.sendIntervalMinutes}">
          </div>
        </div>
        <label for="reply-classifier-mode">返信判定モード</label>
        <select id="reply-classifier-mode" class="settings-input">
          <option value="codex-first" ${settings.replyClassifierMode === "codex-first" ? "selected" : ""}>Codex優先</option>
          <option value="claude-first" ${settings.replyClassifierMode === "claude-first" ? "selected" : ""}>Claude優先</option>
          <option value="llm-only" ${settings.replyClassifierMode === "llm-only" ? "selected" : ""}>LLMのみ</option>
          <option value="keyword-only" ${settings.replyClassifierMode === "keyword-only" ? "selected" : ""}>キーワードのみ</option>
        </select>
        <div class="settings-checks">
          <label class="settings-check"><input id="auto-analyze-permitted" type="checkbox" ${settings.autoAnalyzePermitted ? "checked" : ""}> 許可検出後に自動解析する</label>
          <label class="settings-check"><input id="include-animated-gif" type="checkbox" ${settings.includeAnimatedGif ? "checked" : ""}> animated_gif も取得対象に含める</label>
        </div>
        <div class="settings-actions">
          <button class="settings-save-btn" onclick="saveSettings()">設定を保存</button>
        </div>
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ドラレコ許可管理</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; padding: 20px; }
    .top-nav { display: flex; gap: 10px; margin-bottom: 12px; }
    .top-nav-link { padding: 8px 12px; border-radius: 999px; background: #eef3f8; color: #435466; font-size: 0.82rem; font-weight: 700; text-decoration: none; }
    .top-nav-link.active { background: #dceeff; color: #125ea7; }
    h1 { margin-bottom: 16px; font-size: 1.4rem; }
    .tabs { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 2px solid #eee; }
    .tab { padding: 10px 20px; font-size: 0.9rem; color: #666; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; text-decoration: none; }
    .tab:hover { color: #333; }
    .tab.active { color: #1d9bf0; border-bottom-color: #1d9bf0; font-weight: 600; }
    .tab .tab-count { background: #eee; color: #666; padding: 1px 7px; border-radius: 10px; font-size: 0.72rem; margin-left: 4px; }
    .tab.active .tab-count { background: #e8f4fd; color: #1d9bf0; }
    .tab.permit-tab { color: #28a745; }
    .tab.permit-tab.active { color: #28a745; border-bottom-color: #28a745; }
    .tab.permit-tab.active .tab-count { background: #d4edda; color: #155724; }
    .tab.deny-tab { color: #dc3545; }
    .tab.deny-tab.active { color: #dc3545; border-bottom-color: #dc3545; }
    .tab.deny-tab.active .tab-count { background: #f8d7da; color: #721c24; }
    .settings-board { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 20px; }
    .settings-card { max-width: 760px; }
    .settings-card h2 { font-size: 1.05rem; margin-bottom: 6px; }
    .settings-card label { display: block; font-size: 0.82rem; color: #444; margin-top: 16px; margin-bottom: 6px; font-weight: 700; }
    .settings-help { font-size: 0.76rem; color: #6b7280; line-height: 1.5; }
    .settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .settings-textarea, .settings-input { width: 100%; border: 1px solid #d9e0e7; border-radius: 10px; padding: 10px 12px; font-size: 0.84rem; font-family: inherit; line-height: 1.5; background: #fbfcfe; }
    .settings-textarea { min-height: 180px; resize: vertical; }
    .settings-textarea:focus, .settings-input:focus { border-color: #1d9bf0; outline: none; background: #fff; }
    .settings-checks { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
    .settings-check { font-size: 0.82rem; color: #374151; display: flex; align-items: center; gap: 8px; }
    .settings-actions { margin-top: 16px; }
    .settings-save-btn { padding: 9px 16px; background: #1d9bf0; color: #fff; border: none; border-radius: 10px; font-size: 0.84rem; font-weight: 700; cursor: pointer; }
    .settings-save-btn:hover { background: #1a8cd8; }
    .tweet-text { font-size: 0.84rem; color: #444; margin-top: 10px; line-height: 1.55; word-break: break-word; }
    .tweet-link { font-size: 0.72rem; display: inline-block; }
    .tweet-links { margin-top: 4px; }
    .poster-info { margin-bottom: 12px; display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; background: #f8fafc; border: 1px solid #e7edf3; border-radius: 12px; }
    .poster-info a { font-weight: 600; }
    .poster-details { min-width: 0; flex: 1; }
    .poster-line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .poster-primary { margin-bottom: 4px; }
    .poster-secondary { margin-bottom: 2px; }
    .poster-display-name { font-weight: 700; color: #1f2937; font-size: 0.98rem; line-height: 1.2; }
    .poster-handle { color: #1d9bf0; font-size: 0.9rem; }
    .poster-info .meta { color: #7b8794; font-size: 0.78rem; }
    .poster-dot { color: #b2bcc6; font-size: 0.72rem; }
    .poster-link-btn { margin-left: auto; padding: 4px 10px; border-radius: 999px; background: #e8f4fd; color: #1d9bf0; font-weight: 700; }
    .poster-link-btn:hover { background: #d9ecfb; text-decoration: none; }
    .poster-avatar { width: 44px; height: 44px; border-radius: 999px; flex: 0 0 44px; object-fit: cover; background: #eee; box-shadow: 0 0 0 1px rgba(0,0,0,0.05); }
    .poster-avatar-fallback { display: flex; align-items: center; justify-content: center; color: #666; font-size: 0.9rem; font-weight: 700; }
    .poster-bio { font-size: 0.75rem; color: #5f6b76; margin-top: 6px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
    .poster-actions { margin-top: 8px; }
    .block-user-btn, .unblock-user-btn { border: 1px solid #f1c0c0; background: #fff5f5; color: #c53030; border-radius: 999px; padding: 4px 10px; font-size: 0.72rem; cursor: pointer; }
    .block-user-btn:hover, .unblock-user-btn:hover { background: #ffe3e3; }
    .unblock-user-btn { border-color: #b8d8bf; background: #edf9f0; color: #1d6b34; }
    .unblock-user-btn:hover { background: #dff2e5; }
    .divider { border: none; border-top: 1px solid #e8edf2; margin: 12px 0 10px; }
    .text-actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
    .copy-reply-link { font-size: 0.72rem; color: #28a745; text-decoration: none; }
    .copy-reply-link:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; font-size: 0.85rem; vertical-align: top; }
    th { background: #333; color: #fff; font-weight: 500; }
    a { color: #1d9bf0; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .meta { font-size: 0.75rem; color: #999; margin-top: 4px; }
    .done-row { opacity: 0.5; }
    .video-cell video { width: 100%; border-radius: 6px; display: block; }
    .video-cell video.is-portrait { width: 42%; margin: 0 auto; }
    .reply-textarea { width: 100%; height: 80px; border: 1px solid #ddd; border-radius: 6px; padding: 8px; font-size: 0.82rem; resize: vertical; font-family: inherit; line-height: 1.4; }
    .reply-textarea:focus { border-color: #1d9bf0; outline: none; }
    .regen-btn { margin-top: 4px; padding: 2px 8px; border: 1px solid #ccc; border-radius: 4px; background: #f8f8f8; color: #666; font-size: 0.72rem; cursor: pointer; }
    .regen-btn:hover { background: #eee; }
    .action-cell { white-space: normal; min-width: 168px; }
    .inline-trim-cell { min-width: 240px; }
    .inline-trim-card { padding: 12px; border: 1px solid #e5edf5; border-radius: 14px; background: #f8fbff; }
    .inline-trim-row { display: flex; gap: 8px; margin-bottom: 8px; }
    .inline-trim-row > div { flex: 1; }
    .inline-trim-row label { display: block; margin-bottom: 4px; font-size: 0.72rem; color: #5b6875; font-weight: 700; }
    .inline-trim-row input { width: 100%; padding: 8px 10px; border: 1px solid #d5dde6; border-radius: 10px; font-size: 0.82rem; }
    .inline-trim-actions { display: flex; gap: 8px; margin-bottom: 8px; }
    .trim-point-btn { flex: 1; padding: 8px 10px; border: 1px solid #c9d7ea; border-radius: 10px; background: #fff; color: #345; font-size: 0.78rem; font-weight: 600; cursor: pointer; }
    .trim-point-btn:hover { background: #eef5ff; }
    .trim-save-btn { width: 100%; padding: 10px 12px; border: none; border-radius: 10px; background: #0f9d58; color: #fff; font-size: 0.82rem; font-weight: 700; cursor: pointer; }
    .trim-save-btn:hover { background: #0b8043; }
    .trim-save-btn:disabled { background: #8bc8a7; cursor: not-allowed; }
    .inline-trim-status { margin-top: 8px; font-size: 0.74rem; color: #196c3f; line-height: 1.4; word-break: break-all; }
    .project-assign-box { margin-top: 10px; padding-top: 10px; border-top: 1px solid #dde7f2; }
    .project-select { width: 100%; padding: 8px 10px; border: 1px solid #d5dde6; border-radius: 10px; font-size: 0.8rem; background: #fff; }
    .project-assign-actions { display: flex; gap: 8px; margin-top: 8px; }
    .project-add-btn, .project-create-btn { flex: 1; padding: 8px 10px; border-radius: 10px; font-size: 0.76rem; font-weight: 700; cursor: pointer; }
    .project-add-btn { border: none; background: #1d9bf0; color: #fff; }
    .project-create-btn { border: 1px solid #c9d7ea; background: #fff; color: #345; }
    .action-group { display: flex; gap: 8px; margin-bottom: 8px; }
    .action-group-manual { margin-bottom: 10px; }
    .send-btn { flex: 1; padding: 9px 14px; background: #1d9bf0; color: #fff; border: none; border-radius: 10px; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
    .send-btn:hover { background: #1a8cd8; }
    .send-btn:disabled { background: #93c9f0; cursor: not-allowed; }
    .skip-btn { flex: 1; padding: 9px 14px; background: #fff; color: #8b8b8b; border: 1px solid #ddd; border-radius: 10px; font-size: 0.82rem; font-weight: 500; cursor: pointer; }
    .skip-btn:hover { background: #f5f5f5; color: #666; }
    .mark-sent-btn { width: 100%; padding: 8px 12px; background: #f6fffa; color: #156f39; border: 1px solid #52b773; border-radius: 10px; font-size: 0.76rem; font-weight: 600; cursor: pointer; display: block; }
    .mark-sent-btn:hover { background: #d4edda; }
    .status-select { padding: 4px 8px; border-radius: 10px; font-size: 0.75rem; border: 1px solid #ddd; cursor: pointer; }
    .status-select.pending { background: #fff3cd; color: #856404; }
    .status-select.sent { background: #d4edda; color: #155724; }
    .status-select.skipped { background: #e2e3e5; color: #6c757d; }
    .status-select.error { background: #f8d7da; color: #721c24; }
    .reply-status { padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; }
    .reply-status.permit { background: #d4edda; color: #155724; }
    .reply-status.deny { background: #f8d7da; color: #721c24; }
    .reply-status.replied { background: #cce5ff; color: #004085; }
    .reply-status.undetermined { background: #fff3cd; color: #856404; }
    .reply-block { margin-top: 10px; }
    .reply-block-label { font-size: 0.72rem; color: #6b7280; margin-bottom: 4px; font-weight: 700; }
    .reply-text-display { font-size: 0.8rem; color: #333; background: #f8f9fa; padding: 8px; border-radius: 6px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
    .reply-text-display.received { background: #eef7ff; border: 1px solid #d7eaff; }
    .no-reply { font-size: 0.78rem; color: #999; }
    .okng-buttons { display: flex; gap: 8px; margin-bottom: 6px; }
    .ok-btn { flex: 1; padding: 9px 12px; background: #fff; color: #28a745; border: 2px solid #28a745; border-radius: 10px; font-size: 0.82rem; font-weight: 700; cursor: pointer; }
    .ok-btn:hover { background: #28a745; color: #fff; }
    .ok-btn.active { background: #28a745; color: #fff; }
    .ng-btn { flex: 1; padding: 9px 12px; background: #fff; color: #dc3545; border: 2px solid #dc3545; border-radius: 10px; font-size: 0.82rem; font-weight: 700; cursor: pointer; }
    .ng-btn:hover { background: #dc3545; color: #fff; }
    .ng-btn.active { background: #dc3545; color: #fff; }
    .queued-badge { display: inline-block; padding: 4px 12px; background: #cce5ff; color: #004085; border-radius: 10px; font-size: 0.78rem; font-weight: 500; }
    .sent-badge { display: inline-block; padding: 4px 12px; background: #d4edda; color: #155724; border-radius: 10px; font-size: 0.78rem; font-weight: 500; }
    #toast { position: fixed; bottom: 20px; right: 20px; background: #333; color: #fff; padding: 12px 20px; border-radius: 8px; font-size: 0.85rem; display: none; z-index: 300; }
    .meta-btn { padding: 4px 10px; border: 1px solid #ddd; border-radius: 6px; background: #f8f8f8; color: #666; font-size: 0.78rem; cursor: pointer; }
    .meta-btn:hover { background: #eee; }
    .meta-btn.has-meta { background: #e8f4fd; color: #1d9bf0; border-color: #1d9bf0; }
    @media (max-width: 720px) {
      .poster-info { padding: 10px; }
      .poster-link-btn { margin-left: 0; }
      .tweet-text { font-size: 0.82rem; }
      .settings-grid { grid-template-columns: 1fr; }
    }
    #meta-modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); z-index: 200; justify-content: center; align-items: center; }
    #meta-modal.active { display: flex; }
    .meta-panel { background: #fff; border-radius: 12px; padding: 24px; width: 700px; max-width: 95vw; max-height: 90vh; overflow-y: auto; box-shadow: 0 8px 30px rgba(0,0,0,0.2); }
    .meta-panel h3 { margin-bottom: 16px; font-size: 1rem; }
    .meta-panel video { width: 100%; border-radius: 8px; margin-bottom: 16px; }
    .meta-panel label { display: block; font-size: 0.8rem; color: #666; margin-bottom: 4px; margin-top: 12px; }
    .meta-panel input, .meta-panel textarea, .meta-panel select { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.85rem; font-family: inherit; }
    .meta-panel input:focus, .meta-panel textarea:focus { border-color: #1d9bf0; outline: none; }
    .meta-panel textarea { height: 60px; resize: vertical; }
    .meta-panel .trim-row { display: flex; gap: 12px; align-items: end; }
    .meta-panel .trim-row > div { flex: 1; }
    .meta-panel .trim-actions { display: flex; gap: 8px; margin-top: 10px; }
    .meta-panel .trim-actions button { flex: 1; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 8px; background: #f8fafc; color: #334155; cursor: pointer; }
    .meta-panel .trim-actions button:hover { background: #eef4ff; border-color: #9fc2ff; }
    .meta-panel .trim-hint { margin-top: 8px; font-size: 0.78rem; color: #667085; }
    .meta-panel .trimmed-status { margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: #f4fbf6; color: #196c3f; font-size: 0.8rem; }
    .meta-panel .btn-row { display: flex; gap: 8px; margin-top: 20px; }
    .meta-panel .btn-row button { flex: 1; padding: 10px; border: none; border-radius: 8px; font-size: 0.85rem; cursor: pointer; }
    .meta-save { background: #1d9bf0; color: #fff; }
    .meta-save:hover { background: #1a8cd8; }
    .meta-trim-save { background: #0f9d58; color: #fff; }
    .meta-trim-save:hover { background: #0b8043; }
    .meta-close { background: #f0f0f0; color: #666; }
    .meta-close:hover { background: #e0e0e0; }
    .category-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .category-tags button { padding: 4px 12px; border: 1px solid #ddd; border-radius: 16px; background: #f8f8f8; color: #666; font-size: 0.8rem; cursor: pointer; transition: all 0.15s; }
    .category-tags button:hover { background: #e8f4fd; color: #1d9bf0; border-color: #1d9bf0; }
    .category-tags button.selected { background: #1d9bf0; color: #fff; border-color: #1d9bf0; }
  </style>
</head>
<body>
  <div class="top-nav">
    <a class="top-nav-link active" href="/">素材管理</a>
    <a class="top-nav-link" href="/projects">プロジェクト管理</a>
  </div>
  <h1>ドラレコ許可管理</h1>
  <div class="tabs">
    <a class="tab ${tab === "未送信" ? "active" : ""}" href="/?tab=未送信">未送信<span class="tab-count">${counts["未送信"]}</span></a>
    <a class="tab ${tab === "送信済み" ? "active" : ""}" href="/?tab=送信済み">送信済み<span class="tab-count">${counts["送信済み"]}</span></a>
    <a class="tab permit-tab ${tab === "許可済み" ? "active" : ""}" href="/?tab=許可済み">許可済み<span class="tab-count">${counts["許可済み"]}</span></a>
    <a class="tab ${tab === "トリム済み" ? "active" : ""}" href="/?tab=トリム済み">トリム済み<span class="tab-count">${counts["トリム済み"]}</span></a>
    <a class="tab deny-tab ${tab === "拒否" ? "active" : ""}" href="/?tab=拒否">拒否<span class="tab-count">${counts["拒否"]}</span></a>
    <a class="tab ${tab === "スキップ" ? "active" : ""}" href="/?tab=スキップ">スキップ<span class="tab-count">${counts["スキップ"]}</span></a>
    <a class="tab ${tab === "ブロック" ? "active" : ""}" href="/?tab=ブロック">ブロック<span class="tab-count">${counts["ブロック"]}</span></a>
    <a class="tab ${tab === "設定" ? "active" : ""}" href="/?tab=設定">設定</a>
  </div>
  ${tab === "設定" ? settingsBody : `<table>
    <colgroup>
      <col>
      <col style="width:250px">
      <col style="width:120px">
      <col style="width:100px">
    </colgroup>
    <thead>
      <tr>
        <th>動画</th>
        <th>投稿 / リプライ</th>
        <th>操作</th>
        <th>メタデータ</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="4" style="text-align:center;padding:40px;color:#999;">データがありません</td></tr>'}
    </tbody>
  </table>`}

  <div id="meta-modal">
    <div class="meta-panel">
      <h3>トリム / メタデータ編集</h3>
      <video id="meta-video" controls></video>
      <label>カテゴリ（複数選択可）</label>
      <div class="category-tags" id="meta-categories"></div>
      <label>場所/道路タイプ</label>
      <div class="category-tags" id="meta-locations"></div>
      <label>天候/時間帯</label>
      <div class="category-tags" id="meta-weathers"></div>
      <label>危険度</label>
      <div class="category-tags" id="meta-dangers"></div>
      <div class="trim-row">
        <div>
          <label>トリム開始（秒）</label>
          <input type="number" id="meta-trim-start" step="0.1" min="0" placeholder="0">
        </div>
        <div>
          <label>トリム終了（秒）</label>
          <input type="number" id="meta-trim-end" step="0.1" min="0" placeholder="動画の長さ">
        </div>
      </div>
      <div class="trim-actions">
        <button onclick="setTrimPoint('start')">現在位置を開始にセット</button>
        <button onclick="setTrimPoint('end')">現在位置を終了にセット</button>
      </div>
      <div class="trim-hint" id="meta-trim-hint">動画を再生しながら開始/終了位置を決めてください</div>
      <div class="trimmed-status" id="meta-trimmed-status" style="display:none;"></div>
      <div class="btn-row">
        <button class="meta-close" onclick="closeMeta()">キャンセル</button>
        <button class="meta-save" onclick="saveMeta()">メタデータ保存</button>
        <button class="meta-trim-save" onclick="saveTrimmed()">保存してトリム出力</button>
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    let currentMetaId = null;
    let currentMetaVideoSrc = null;
    const PRESETS = {
      categories: ['信号無視','逆走','煽り運転','割り込み','一時停止無視','接触寸前','方向指示器不使用','速度超過','危険運転','飛び出し','車間距離不保持','蛇行運転','当て逃げ','その他'],
      locations: ['交差点','高速道路','一般道','住宅街','駐車場','細い道','合流地点','カーブ'],
      weathers: ['晴れ','曇り','雨','雪','夜間','夕方','朝'],
      dangers: ['高','中','低'],
    };
    const selected = { categories: new Set(), locations: new Set(), weathers: new Set(), dangers: new Set() };

    function renderTags(key, containerId) {
      const container = document.getElementById(containerId);
      container.innerHTML = PRESETS[key].map(c =>
        '<button class="' + (selected[key].has(c) ? 'selected' : '') + '" onclick="toggleTag(\\'' + key + '\\', this, \\'' + c + '\\')">' + c + '</button>'
      ).join('');
    }

    function toggleTag(key, btn, val) {
      if (selected[key].has(val)) { selected[key].delete(val); btn.classList.remove('selected'); }
      else { selected[key].add(val); btn.classList.add('selected'); }
    }

    function parseCSV(str) { return new Set(str ? str.split(',').map(s => s.trim()).filter(Boolean) : []); }

    function formatSeconds(value) {
      if (value == null || Number.isNaN(Number(value))) return '-';
      return Number(value).toFixed(1) + '秒';
    }

    function updateTrimHint() {
      const start = document.getElementById('meta-trim-start').value;
      const end = document.getElementById('meta-trim-end').value;
      document.getElementById('meta-trim-hint').textContent =
        '開始 ' + (start ? formatSeconds(start) : '0.0秒') + ' / 終了 ' + (end ? formatSeconds(end) : '動画末尾');
    }

    async function openMeta(id, videoSrc) {
      currentMetaId = id;
      currentMetaVideoSrc = videoSrc;
      document.getElementById('meta-video').src = videoSrc;
      const res = await fetch('/api/metadata/' + id);
      const data = await res.json();
      selected.categories = parseCSV(data.category);
      selected.locations = parseCSV(data.location);
      selected.weathers = parseCSV(data.weather);
      selected.dangers = parseCSV(data.danger_level);
      renderTags('categories', 'meta-categories');
      renderTags('locations', 'meta-locations');
      renderTags('weathers', 'meta-weathers');
      renderTags('dangers', 'meta-dangers');
      document.getElementById('meta-trim-start').value = data.trim_start ?? '';
      document.getElementById('meta-trim-end').value = data.trim_end ?? '';
      document.getElementById('meta-trimmed-status').style.display = data.trimmed_video_path ? 'block' : 'none';
      document.getElementById('meta-trimmed-status').textContent = data.trimmed_video_path
        ? '保存済み: /' + data.trimmed_video_path + (data.trimmed_at ? ' (' + data.trimmed_at + ')' : '')
        : '';
      updateTrimHint();
      document.getElementById('meta-modal').classList.add('active');
    }

    function closeMeta() {
      document.getElementById('meta-modal').classList.remove('active');
      document.getElementById('meta-video').pause();
      document.getElementById('meta-video').removeAttribute('src');
      document.getElementById('meta-video').load();
      currentMetaId = null;
      currentMetaVideoSrc = null;
    }

    function buildMetaPayload() {
      return {
        category: [...selected.categories].join(','),
        location: [...selected.locations].join(','),
        weather: [...selected.weathers].join(','),
        danger_level: [...selected.dangers].join(','),
        trim_start: parseFloat(document.getElementById('meta-trim-start').value) || null,
        trim_end: parseFloat(document.getElementById('meta-trim-end').value) || null,
      };
    }

    async function persistMeta() {
      const body = buildMetaPayload();
      const res = await fetch('/api/metadata/' + currentMetaId, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error('メタデータ保存に失敗しました');
    }

    async function saveMeta() {
      await persistMeta();
      showToast('メタデータを保存しました');
      closeMeta();
      location.reload();
    }

    async function saveTrimmed() {
      await persistMeta();
      const res = await fetch('/api/trim/' + currentMetaId, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'トリム保存に失敗しました');
        return;
      }
      showToast('トリム済み動画を保存しました');
      closeMeta();
      location.reload();
    }

    function setTrimPoint(which) {
      const video = document.getElementById('meta-video');
      const current = Number(video.currentTime || 0).toFixed(1);
      if (which === 'start') {
        document.getElementById('meta-trim-start').value = current;
      } else {
        document.getElementById('meta-trim-end').value = current;
      }
      updateTrimHint();
    }

    function setInlineTrimPoint(id, which) {
      const video = document.getElementById('video-' + id);
      if (!video) return;
      const current = Number(video.currentTime || 0).toFixed(1);
      const input = document.getElementById('trim-' + which + '-' + id);
      if (input) input.value = current;
    }

    async function saveTrimmedInline(id, btn) {
      const startInput = document.getElementById('trim-start-' + id);
      const endInput = document.getElementById('trim-end-' + id);
      const trim_start = startInput && startInput.value !== '' ? parseFloat(startInput.value) : null;
      const trim_end = endInput && endInput.value !== '' ? parseFloat(endInput.value) : null;

      btn.disabled = true;
      btn.textContent = '保存中...';
      try {
        const res = await fetch('/api/trim/' + id, {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ trim_start, trim_end })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'トリム保存に失敗しました');
          return;
        }
        showToast('トリム済み動画を保存しました');
        setTimeout(() => location.reload(), 400);
      } finally {
        btn.disabled = false;
        btn.textContent = '保存してトリム出力';
      }
    }

    async function assignAssetToProject(id, projectId) {
      const resolvedProjectId = projectId || document.getElementById('project-select-' + id)?.value;
      if (!resolvedProjectId) return showToast('プロジェクトを選択してください');
      const res = await fetch('/api/projects/' + resolvedProjectId + '/add-asset', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ targetId: id })
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || 'プロジェクト追加に失敗しました');
      showToast('プロジェクトに追加しました');
      setTimeout(() => location.reload(), 400);
    }

    async function createProjectAndAssign(id) {
      const title = window.prompt('プロジェクト名を入力してください', '');
      if (title == null) return;
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ title })
      });
      const data = await res.json();
      if (!res.ok) return showToast('プロジェクト作成に失敗しました');
      await assignAssetToProject(id, data.id);
    }

    document.getElementById('meta-trim-start').addEventListener('input', updateTrimHint);
    document.getElementById('meta-trim-end').addEventListener('input', updateTrimHint);

    document.getElementById('meta-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeMeta();
    });

    function setupVisibleVideoAutoplay() {
      const videos = Array.from(document.querySelectorAll('.js-autoplay-video'));
      if (!videos.length) return;

      const pauseVideo = (video) => {
        if (!video.paused) video.pause();
      };

      const tryPlayVideo = (video) => {
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {});
        }
      };

      if (!('IntersectionObserver' in window)) {
        videos.forEach(tryPlayVideo);
        return;
      }

      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            tryPlayVideo(entry.target);
            return;
          }
          pauseVideo(entry.target);
        });
      }, {
        threshold: [0, 0.6, 1],
      });

      videos.forEach((video) => {
        pauseVideo(video);
        const applyOrientationClass = () => {
          const isPortrait = video.videoHeight > video.videoWidth;
          video.classList.toggle('is-portrait', isPortrait);
        };

        if (video.readyState >= 1) {
          applyOrientationClass();
        } else {
          video.addEventListener('loadedmetadata', applyOrientationClass, { once: true });
        }

        observer.observe(video);
      });

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          videos.forEach(pauseVideo);
        }
      });
    }

    setupVisibleVideoAutoplay();

    async function send(id, btn) {
      const textarea = document.getElementById('text-' + id);
      const text = textarea.value.trim();
      if (!text) return showToast('文面が空です');
      btn.disabled = true;
      btn.textContent = '予約中...';
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ id, text })
      });
      const data = await res.json();
      if (data.ok) {
        showToast('送信キューに追加しました（' + data.position + '件目）');
        const actionCell = document.getElementById('action-' + id);
        actionCell.innerHTML = '<span class="queued-badge">送信待ち #' + data.position + '</span>';
        textarea.disabled = true;
        textarea.style.opacity = '0.5';
      } else {
        showToast(data.message);
        btn.disabled = false;
        btn.textContent = '送信';
      }
    }

    async function skip(id, btn) {
      await fetch('/api/status/' + id, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ status: 'スキップ' })
      });
      showToast('スキップしました');
      const row = btn.closest('tr');
      row.classList.add('done-row');
      setTimeout(() => location.reload(), 500);
    }

    async function markSent(id, btn) {
      const res = await fetch('/api/status/' + id, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ status: '送信済み' })
      });
      const data = await res.json();
      showToast(data.message || '送信済みにしました');
      const row = btn.closest('tr');
      row.classList.add('done-row');
      setTimeout(() => row.remove(), 150);
    }

    async function revert(id) {
      await fetch('/api/status/' + id, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ status: '未送信' })
      });
      showToast('未送信に戻しました');
      setTimeout(() => location.reload(), 500);
    }

    async function copyAndOpen(id, tweetId) {
      const textarea = document.getElementById('text-' + id);
      const text = textarea.value.trim();
      if (!text) return showToast('文面が空です');
      const intentUrl = 'https://twitter.com/intent/tweet?in_reply_to=' + tweetId + '&text=' + encodeURIComponent(text);
      const popup = window.open('', '_blank');

      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          textarea.focus();
          textarea.select();
          textarea.setSelectionRange(0, textarea.value.length);
          document.execCommand('copy');
          textarea.setSelectionRange(text.length, text.length);
          textarea.blur();
        }
        showToast('文面をコピーして返信画面を開きました');
      } catch (error) {
        showToast('返信画面を開きました。コピーは手動でお願いします');
      }

      if (popup) {
        popup.opener = null;
        popup.location = intentUrl;
      } else {
        showToast('新規タブを開けなかったため、このタブで返信画面を開きます');
        location.href = intentUrl;
      }
    }

    async function regen(id) {
      const res = await fetch('/api/reply-text');
      const { text } = await res.json();
      document.getElementById('text-' + id).value = text;
    }

    async function changeStatus(id, status, el) {
      await fetch('/api/status/' + id, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ status })
      });
      el.className = 'status-select ' +
        (status === '未送信' ? 'pending' : status === '送信済み' ? 'sent' : status === 'スキップ' ? 'skipped' : 'error');
      showToast('ステータスを「' + status + '」に変更');
      if (status === '未送信') setTimeout(() => location.reload(), 500);
    }

    async function setReplyStatus(id, status, btn) {
      await fetch('/api/reply-status/' + id, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ reply_status: status })
      });
      showToast(status === '許可' ? 'OK — 許可済みに移動' : 'NG — 拒否に移動');
      setTimeout(() => location.reload(), 500);
    }

    async function blockUser(username, btn) {
      const res = await fetch('/api/block-user/' + encodeURIComponent(username), {
        method: 'POST',
        headers: {'Content-Type':'application/json'}
      });
      if (!res.ok) {
        showToast('@' + username + ' の非表示に失敗しました');
        return;
      }
      showToast('@' + username + ' をブロック対象に追加しました');
      setTimeout(() => location.reload(), 200);
    }

    async function unblockUser(username, btn) {
      const res = await fetch('/api/unblock-user/' + encodeURIComponent(username), {
        method: 'POST',
        headers: {'Content-Type':'application/json'}
      });
      if (!res.ok) {
        showToast('@' + username + ' のブロック解除に失敗しました');
        return;
      }
      showToast('@' + username + ' のブロックを解除しました');
      setTimeout(() => location.reload(), 200);
    }

    function parseMonitorAccounts(text) {
      return text
        .split(/\\r?\\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(',');
          const username = (parts.shift() || '').trim().replace(/^@/, '');
          const label = parts.join(',').trim();
          return { username, label };
        })
        .filter((account) => account.username);
    }

    async function saveSettings() {
      const monitorAccounts = parseMonitorAccounts(document.getElementById('monitor-accounts').value);
      const crawlDays = document.getElementById('crawl-days').value;
      const channelName = document.getElementById('channel-name').value.trim();
      const dailySendLimit = document.getElementById('daily-send-limit').value;
      const sendIntervalMinutes = document.getElementById('send-interval-minutes').value;
      const replyClassifierMode = document.getElementById('reply-classifier-mode').value;
      const autoAnalyzePermitted = document.getElementById('auto-analyze-permitted').checked;
      const includeAnimatedGif = document.getElementById('include-animated-gif').checked;
      if (!monitorAccounts.length) {
        showToast('監視アカウントを1件以上入力してください');
        return;
      }
      if (!channelName) {
        showToast('チャンネル名を入力してください');
        return;
      }
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ monitorAccounts, crawlDays, channelName, dailySendLimit, sendIntervalMinutes, replyClassifierMode, autoAnalyzePermitted, includeAnimatedGif })
      });
      const data = await res.json();
      if (!data.ok) {
        showToast('設定の保存に失敗しました');
        return;
      }
      showToast('設定を保存しました。次回の取得から反映されます');
    }

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 3000);
    }

    // キュー状態を表示
    (async () => {
      const res = await fetch('/api/queue');
      const data = await res.json();
      if (data.queue.length > 0) {
        showToast('送信キュー: ' + data.queue.length + '件処理中');
      }
    })();
  </script>
</body>
</html>`;
}

function renderProjectsPage(projects) {
  const rows = projects.map((project) => `
    <tr>
      <td><a href="/projects/${project.id}">${escapeHtml(project.project_code)}</a></td>
      <td>${escapeHtml(project.title || "新規プロジェクト")}</td>
      <td>${escapeHtml(project.status || "draft")}</td>
      <td>${project.asset_count}</td>
      <td>${escapeHtml(project.updated_at || project.created_at || "-")}</td>
    </tr>
  `).join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>プロジェクト管理</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f7fb; padding: 20px; color: #1f2937; }
    .top-nav { display: flex; gap: 10px; margin-bottom: 12px; }
    .top-nav-link { padding: 8px 12px; border-radius: 999px; background: #eef3f8; color: #435466; font-size: 0.82rem; font-weight: 700; text-decoration: none; }
    .top-nav-link.active { background: #dceeff; color: #125ea7; }
    h1 { margin-bottom: 16px; font-size: 1.4rem; }
    .hero { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 16px; }
    .hero p { color: #667085; font-size: 0.86rem; }
    .create-box { display: flex; gap: 8px; }
    .create-box input { width: 280px; padding: 10px 12px; border: 1px solid #d9e0e7; border-radius: 10px; background: #fff; }
    .create-box button { padding: 10px 14px; border: none; border-radius: 10px; background: #1d9bf0; color: #fff; font-weight: 700; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    th, td { padding: 14px 16px; border-bottom: 1px solid #edf1f5; text-align: left; font-size: 0.86rem; }
    th { background: #28323c; color: #fff; font-weight: 600; }
    a { color: #1d9bf0; text-decoration: none; }
    #toast { position: fixed; bottom: 20px; right: 20px; background: #333; color: #fff; padding: 12px 20px; border-radius: 8px; display: none; }
  </style>
</head>
<body>
  <div class="top-nav">
    <a class="top-nav-link" href="/">素材管理</a>
    <a class="top-nav-link active" href="/projects">プロジェクト管理</a>
  </div>
  <div class="hero">
    <div>
      <h1>プロジェクト管理</h1>
      <p>トリム済み素材を案件単位で束ねます。詳細ページで素材とコメントファイルを確認できます。</p>
    </div>
    <div class="create-box">
      <input id="project-title" type="text" placeholder="例: 2026-03-26 危険運転まとめ">
      <button onclick="createProject()">新規プロジェクト作成</button>
    </div>
  </div>
  <table>
    <thead>
      <tr><th>コード</th><th>タイトル</th><th>状態</th><th>素材数</th><th>更新日時</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="5" style="text-align:center;color:#98a2b3;padding:36px;">まだプロジェクトがありません</td></tr>'}
    </tbody>
  </table>
  <div id="toast"></div>
  <script>
    async function createProject() {
      const title = document.getElementById('project-title').value.trim();
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ title })
      });
      const data = await res.json();
      if (!res.ok) return showToast('プロジェクト作成に失敗しました');
      location.href = '/projects/' + data.id;
    }
    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 3000);
    }
  </script>
</body>
</html>`;
}

function renderProjectDetailPage(project, assets) {
  const rows = assets.map((asset) => {
    const videoPath = asset.trimmed_video_path ? `/${asset.trimmed_video_path}` : "";
    const commentaryPath = asset.trimmed_video_path ? `/${asset.trimmed_video_path.split("/").slice(0, -1).join("/")}/commentary.md` : "";
    return `
      <tr>
        <td>${videoPath ? `<video src="${videoPath}" controls muted playsinline preload="metadata" style="width:220px;border-radius:10px;"></video>` : "-"}</td>
        <td>
          <div style="font-weight:700;">@${escapeHtml(asset.username)}</div>
          <div style="font-size:0.78rem;color:#667085;margin-top:4px;">${escapeHtml(asset.tweet_url)}</div>
          <div style="font-size:0.78rem;color:#667085;margin-top:8px;">カテゴリ: ${escapeHtml(asset.category || "-")}</div>
          <div style="font-size:0.78rem;color:#667085;">危険度: ${escapeHtml(asset.danger_level || "-")}</div>
        </td>
        <td>
          <div style="font-size:0.8rem;">${asset.selected_comment ? escapeHtml(asset.selected_comment) : "未設定"}</div>
          <div style="margin-top:8px;font-size:0.78rem;color:#667085;">${escapeHtml(asset.editor_note || "")}</div>
        </td>
        <td>
          ${commentaryPath ? `<a href="${commentaryPath}" target="_blank">commentary.md</a>` : "-"}<br>
          ${videoPath ? `<a href="${videoPath}" target="_blank" style="margin-top:6px;display:inline-block;">動画を開く</a>` : ""}
        </td>
      </tr>
    `;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(project.project_code)} | プロジェクト</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f7fb; padding: 20px; color: #1f2937; }
    .top-nav { display: flex; gap: 10px; margin-bottom: 12px; }
    .top-nav-link { padding: 8px 12px; border-radius: 999px; background: #eef3f8; color: #435466; font-size: 0.82rem; font-weight: 700; text-decoration: none; }
    .top-nav-link.active { background: #dceeff; color: #125ea7; }
    h1 { margin-bottom: 4px; font-size: 1.4rem; }
    .sub { color: #667085; margin-bottom: 16px; font-size: 0.86rem; }
    .summary { display: flex; gap: 12px; margin-bottom: 16px; }
    .summary-card { background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); min-width: 180px; }
    .summary-card .label { color: #667085; font-size: 0.76rem; }
    .summary-card .value { margin-top: 6px; font-size: 1.1rem; font-weight: 800; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    th, td { padding: 14px 16px; border-bottom: 1px solid #edf1f5; text-align: left; vertical-align: top; font-size: 0.86rem; }
    th { background: #28323c; color: #fff; font-weight: 600; }
    a { color: #1d9bf0; text-decoration: none; }
  </style>
</head>
<body>
  <div class="top-nav">
    <a class="top-nav-link" href="/">素材管理</a>
    <a class="top-nav-link active" href="/projects">プロジェクト管理</a>
  </div>
  <h1>${escapeHtml(project.project_code)} ${project.title ? `| ${escapeHtml(project.title)}` : ""}</h1>
  <div class="sub">素材の束ね先です。ここからコメント生成や編集書き出しを追加していきます。</div>
  <div class="summary">
    <div class="summary-card"><div class="label">状態</div><div class="value">${escapeHtml(project.status || "draft")}</div></div>
    <div class="summary-card"><div class="label">素材数</div><div class="value">${assets.length}</div></div>
    <div class="summary-card"><div class="label">更新</div><div class="value" style="font-size:0.9rem;">${escapeHtml(project.updated_at || project.created_at || "-")}</div></div>
  </div>
  <table>
    <thead>
      <tr><th>動画</th><th>素材情報</th><th>採用コメント/メモ</th><th>ファイル</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="4" style="text-align:center;color:#98a2b3;padding:36px;">まだ素材がありません</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`管理画面: http://localhost:${PORT}`);
});
