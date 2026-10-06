# Transcript sources

Best-effort lookup for a past session when the human did not pass a file or paste. Current-session capture uses in-context history and does not read a file.

## Probe (one pass)

`scripts/locate-session-transcript.mjs` walks these stores and returns the newest `.jsonl` by mtime.

| Source | Path under `--home` | Scope |
|---|---|---|
| Claude Code | `.claude/projects/<cwd-encoded>/**/*.jsonl` | cwd-encoded: replace `/`, `\`, and `:` in `--cwd` with `-` |
| Codex | `.codex/sessions/**/rollout-*.jsonl` | global date tree (`YYYY/MM/DD`) |
| Pi | `.pi/agent/sessions/**/*.jsonl` | global |

`--path <file>` skips probing: readable file → `{"ok":true,"path":"...","source":"explicit"}`; otherwise `{"ok":false,"reason":"unreadable"}`.

No match → `{"ok":false,"reason":"not_found"}`. Show a found path to the human before extracting.

## Unsupported stores

Cursor (`~/.cursor/chats/**/store.db`) and OpenCode (`~/.local/share/opencode/opencode.db`) are undocumented SQLite. Do not open or parse them. Those harnesses resolve as `not_found` unless the human points at a file or pastes text.

## Point-or-paste

When lookup returns `not_found` or `unreadable`, ask the human for a file path or pasted history and use that directly.
