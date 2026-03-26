import { getDashboardSettings } from "./app-settings.mjs";

const openers = [
  "動画拝見しました！",
  "映像を拝見いたしました！",
  "すごい瞬間ですね！",
  "衝撃的な映像ですね！",
  "貴重な映像を拝見しました！",
  "ドラレコ映像、拝見しました！",
  "こちらの映像、思わず見入ってしまいました！",
  "すごい映像ですね、驚きました！",
  "臨場感のある映像ですね！",
  "インパクトのある映像ですね！",
];

function buildRequests(channelName) {
  return [
    `「${channelName}」というYouTubeチャンネルで紹介させていただくことは可能でしょうか？`,
    `YouTubeチャンネル「${channelName}」にてご紹介させていただけないでしょうか？`,
    `当チャンネル「${channelName}」(YouTube)でご紹介させていただけますと幸いです。ご検討いただけますか？`,
    `YouTube「${channelName}」で取り上げさせていただきたいのですが、許可をいただけますでしょうか？`,
    `「${channelName}」というYouTubeチャンネルを運営しております。こちらの映像をご紹介させていただけませんか？`,
    `YouTubeでドラレコ映像をまとめております「${channelName}」と申します。こちらの動画を使用させていただくことは可能でしょうか？`,
  ];
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateReplyText() {
  const { channelName } = getDashboardSettings();
  return `${pick(openers)}\n${pick(buildRequests(channelName))}`;
}
