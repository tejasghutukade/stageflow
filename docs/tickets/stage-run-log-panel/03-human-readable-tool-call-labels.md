# 03: Human-readable tool-call labels

**What to build:** Replace the raw tool-name-only labels for tool-call rows with parsed, human-readable labels — e.g. "Read [filename]" for file reads, "Bash [command]" for shell commands — derived from the already-captured structured tool arguments. Tools without a known argument mapping fall back to the raw tool name rather than breaking.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] A file-read tool-call row displays as "Read [filename]" using the actual file path from that call's arguments.
- [ ] A Bash tool-call row displays as "Bash [command]" using the actual command from that call's arguments.
- [ ] A tool call whose arguments fail to parse, or whose tool name isn't in the known mapping, still renders a sensible label (the raw tool name) instead of an error or blank row.
- [ ] File contents from read calls are never shown in the collapsed or expanded label — only the filename.
