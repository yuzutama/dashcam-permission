import db from "./db.mjs";
import { CHANNEL_NAME, COMPETITOR_ACCOUNTS, CRAWL_DAYS, DAILY_SEND_LIMIT, SEND_INTERVAL_MS } from "./constants.mjs";

const DEFAULT_SETTINGS = {
  monitorAccounts: COMPETITOR_ACCOUNTS,
  crawlDays: CRAWL_DAYS,
  channelName: CHANNEL_NAME,
  dailySendLimit: DAILY_SEND_LIMIT,
  sendIntervalMinutes: Math.round(SEND_INTERVAL_MS / 60000),
  replyClassifierMode: "codex-first",
  autoAnalyzePermitted: true,
  includeAnimatedGif: true,
};

function normalizeUsername(username) {
  return String(username || "").trim().replace(/^@/, "");
}

function normalizeMonitorAccounts(accounts) {
  if (!Array.isArray(accounts)) return DEFAULT_SETTINGS.monitorAccounts;

  const normalized = accounts
    .map((account) => {
      if (!account) return null;
      const username = normalizeUsername(account.username);
      if (!username) return null;
      return {
        username,
        label: String(account.label || "").trim() || "監視対象",
      };
    })
    .filter(Boolean);

  return normalized.length ? normalized : DEFAULT_SETTINGS.monitorAccounts;
}

function normalizeCrawlDays(value) {
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days)) return DEFAULT_SETTINGS.crawlDays;
  return Math.min(365, Math.max(1, days));
}

function normalizeDailySendLimit(value) {
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit)) return DEFAULT_SETTINGS.dailySendLimit;
  return Math.min(500, Math.max(1, limit));
}

function normalizeSendIntervalMinutes(value) {
  const minutes = Number.parseInt(value, 10);
  if (!Number.isFinite(minutes)) return DEFAULT_SETTINGS.sendIntervalMinutes;
  return Math.min(24 * 60, Math.max(1, minutes));
}

function normalizeChannelName(value) {
  const channelName = String(value || "").trim();
  return channelName || DEFAULT_SETTINGS.channelName;
}

function normalizeReplyClassifierMode(value) {
  const allowed = ["codex-first", "claude-first", "keyword-only", "llm-only"];
  return allowed.includes(value) ? value : DEFAULT_SETTINGS.replyClassifierMode;
}

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

function getSettingValue(key) {
  return db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value ?? null;
}

export function getDashboardSettings() {
  const accountsRaw = getSettingValue("monitor_accounts");
  const crawlDaysRaw = getSettingValue("crawl_days");

  let monitorAccounts = DEFAULT_SETTINGS.monitorAccounts;
  if (accountsRaw) {
    try {
      monitorAccounts = normalizeMonitorAccounts(JSON.parse(accountsRaw));
    } catch {
      monitorAccounts = DEFAULT_SETTINGS.monitorAccounts;
    }
  }

  return {
    monitorAccounts,
    crawlDays: normalizeCrawlDays(crawlDaysRaw),
    channelName: normalizeChannelName(getSettingValue("channel_name")),
    dailySendLimit: normalizeDailySendLimit(getSettingValue("daily_send_limit")),
    sendIntervalMinutes: normalizeSendIntervalMinutes(getSettingValue("send_interval_minutes")),
    replyClassifierMode: normalizeReplyClassifierMode(getSettingValue("reply_classifier_mode")),
    autoAnalyzePermitted: normalizeBoolean(getSettingValue("auto_analyze_permitted"), DEFAULT_SETTINGS.autoAnalyzePermitted),
    includeAnimatedGif: normalizeBoolean(getSettingValue("include_animated_gif"), DEFAULT_SETTINGS.includeAnimatedGif),
  };
}

export function saveDashboardSettings(input = {}) {
  const settings = {
    monitorAccounts: normalizeMonitorAccounts(input.monitorAccounts),
    crawlDays: normalizeCrawlDays(input.crawlDays),
    channelName: normalizeChannelName(input.channelName),
    dailySendLimit: normalizeDailySendLimit(input.dailySendLimit),
    sendIntervalMinutes: normalizeSendIntervalMinutes(input.sendIntervalMinutes),
    replyClassifierMode: normalizeReplyClassifierMode(input.replyClassifierMode),
    autoAnalyzePermitted: normalizeBoolean(input.autoAnalyzePermitted, DEFAULT_SETTINGS.autoAnalyzePermitted),
    includeAnimatedGif: normalizeBoolean(input.includeAnimatedGif, DEFAULT_SETTINGS.includeAnimatedGif),
  };

  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const tx = db.transaction(() => {
    upsert.run("monitor_accounts", JSON.stringify(settings.monitorAccounts));
    upsert.run("crawl_days", String(settings.crawlDays));
    upsert.run("channel_name", settings.channelName);
    upsert.run("daily_send_limit", String(settings.dailySendLimit));
    upsert.run("send_interval_minutes", String(settings.sendIntervalMinutes));
    upsert.run("reply_classifier_mode", settings.replyClassifierMode);
    upsert.run("auto_analyze_permitted", settings.autoAnalyzePermitted ? "true" : "false");
    upsert.run("include_animated_gif", settings.includeAnimatedGif ? "true" : "false");
  });

  tx();
  return settings;
}
