---
name: reply-check
description: Run the dashcam reply-monitor workflow for dashcam-permission. Use when the user asks to check whether sent permission requests received replies, to run `npm run check`, to interpret `許可 / 拒否 / 返信あり / 判定不可`, or to explain how reply text appears in the management UI.
---

# Reply Check

Run this skill only inside the `dashcam-permission` project when the task is about incoming replies to sent permission requests.

## Workflow

1. Confirm the working directory is the project root.
2. Run `npm run check`.
3. Summarize:
   - how many targets were checked
   - which accounts received replies
   - each classification result: `許可`, `拒否`, `返信あり`, or `判定不可`
   - whether automatic video analysis was triggered
4. If helpful, explain where the result will appear in the management UI:
   - `許可` moves to the `許可済み` tab
   - `拒否` moves to the `拒否` tab
   - `返信あり` stays in `送信済み`
   - `判定不可` stays in `送信済み` and should be described to the user as `判定できませんでした`

## Interpretation Rules

- Treat `npm run check` as the source of truth for reply detection.
- The script fetches replies from X, stores the received text in SQLite, and updates `reply_status`.
- The current implementation tries local LLM classification first and falls back only if needed.
- If no reply is found, say that explicitly instead of implying failure.
- If the command errors, report the exact failure point briefly and do not guess the result.

## Response Style

- Lead with outcome first.
- Include concrete account names or counts when available.
- If nothing changed, say that directly.
- Do not restate the whole implementation unless the user asks.
