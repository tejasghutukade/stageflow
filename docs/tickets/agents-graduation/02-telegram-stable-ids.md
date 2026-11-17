# 02: Telegram: stable user ids, no groups

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** —

## Why

`parseTelegramInbound` (`src/agents/communications/telegram.ts`) reports the sender as `from.username`. A username can be changed and later taken by someone else, so an allow-list entry can end up admitting a different person. Group chats are not filtered, so a whole group shares one session with the bot.

## Read first

- `src/agents/communications/telegram.ts`, `allowlist.ts` (`SENDER_ENTRY`, `senderAllowed`), `src/config/loadAgent.ts` (`channelSchema`).
- Telegram Bot API `Message`, `User`, `Chat` objects (check the current docs, do not rely on memory).
- `docs/agents.md` allow-list table, `docs/guides-agents-telegram.md`, the agent editor's channel section in `ui/`.

## What to build

1. Use the numeric `from.id` as the sender. Keep the username only as a display label.
2. Allow-list grammar: accept a numeric Telegram user id entry. Keep `@username` entries loading, matched against the current username, and add a save-time warning finding that a username entry is weaker than an id.
3. Ignore messages whose `chat.type` is not `private` (same reasoning as iMessage groups in `imessageListener.ts`).
4. A way to learn an id: when a not-allowed sender writes, record their id and username where the operator can see it (the agent's channel status), without answering them.
5. Docs and the editor copy.

## Acceptance

- [ ] An id entry admits that user after a username change (test).
- [ ] A different user who takes an allowed username is admitted only by a `@username` entry, and that entry shows the warning.
- [ ] Group, supergroup and channel messages are ignored with `{ ignored: true }`.
- [ ] New finding code documented in `docs/agent-definition.md`.

## Out of scope

Group support.

## Outcome

Done in 0.66.0, except step 4 in part: a refused sender's id is written to the Host log, not shown on the agent's channel status in the console.
