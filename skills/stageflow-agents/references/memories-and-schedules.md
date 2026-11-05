# Memories and schedules

Facts that survive across sessions, and a cron that starts a new session. Neither is a pipeline trigger. Field shapes are in [agent-definition.md](agent-definition.md).

## Contents

- [Memories](#memories)
- [Create, then attach](#create-then-attach)
- [What a session is given](#what-a-session-is-given)
- [Caps and codes](#caps-and-codes)
- [Schedules](#schedules)
- [Always on](#always-on)

## Memories

A memory is a cover page plus keyed cards, stored on the Host under `$STAGEFLOW_HOME`. The id matches `^[a-z][a-z0-9_-]{0,63}$`. The description is 1 to 500 characters and is fixed at create. There is no route and no tool that deletes a memory or changes its description.

There is no `sf` command for memories. Use MCP or REST. REST writes need `Origin: http://127.0.0.1:${STAGEFLOW_SERVICE_PORT:-3847}`. Bearer rules are in [control-surface.md](control-surface.md#http). Console: Memories, `#/memories`.

| Action | MCP | REST |
|---|---|---|
| List (id, description, card count) | `list_memories` | `GET /api/memories` |
| Read description, cover, and (MCP) card keys | `get_memory { id }` | `GET /api/memories/<id>` returns the description and the cover as `body`. Card keys: `GET /api/memories/<id>/cards`. One card: `GET /api/memories/<id>/cards?key=` |
| Create | `create_memory { id, description }` | `POST /api/memories` with `{ "id", "description" }` → 201. The cover starts empty |
| Replace the cover | `write_memory { id, body }` | `PATCH /api/memories/<id>` with `{ "body" }` |
| Replace an existing card | `write_memory_card { id, key, body }` | `PATCH /api/memories/<id>/cards` with `{ "key", "body" }` |
| Delete a card | `delete_memory_card { id, key }` | `DELETE /api/memories/<id>/cards` with `{ "key" }` |
| Previous cover | none | `GET /api/memories/<id>/previous` |
| Previous card | none | `GET /api/memories/<id>/cards/previous?key=` |

No tool and no route can add a new card. `write_memory_card` and the PATCH replace a card that already exists; a missing card is `MEMORY_CARD_NOT_FOUND`. A session's `add_memory_card` is the only way to create one. There is no restore from the previous copy; the previous routes only read it.

MCP errors are `{ "error": "<CODE>" }`. REST errors are `{ "code": "<CODE>" }`. When the Host has no memory store, MCP returns `{ "error": "MEMORIES_UNAVAILABLE" }` and REST returns 503 `{ "code": "memory.unavailable" }`.

## Create, then attach

`memories: [<id>, …]` on the agent. A missing, unreadable, or invalid id is `agent.memory_unavailable` and blocks validate, save, and enable. Create the memory first, then write the file, then validate.

Sub-agents do not inherit the list. Each agent that should see the memory names it.

Do not attach a memory to a public web agent. Public chat refuses memories with `identity.setup_required`. See [channels-and-identity.md](channels-and-identity.md).

Seed facts you want present on the first run with `write_memory` (the cover) before the agent is enabled. Card keys should be stable (an email, an order id, a date), so a later session can find the same card.

## What a session is given

Attaching a memory adds this to the system prompt: the id and the description of each memory, then instructions to call the tools below. The cover text and the card bodies are not in the prompt, and neither is a file path.

The runtime also registers these tools on the session:

| Tool | Effect |
|---|---|
| `read_memory` | Cover of an attached memory. Argument `memory` |
| `replace_memory` | Replace the whole cover. Arguments `memory`, `content` |
| `add_memory_card` | Create a card. A second add of the same key is `MEMORY_CARD_EXISTS` |
| `update_memory_card` | Replace a card that exists. A missing key is `MEMORY_CARD_NOT_FOUND` |
| `read_memory_card` | Current card body |
| `search_memory_cards` | Case-insensitive scan of keys and bodies. At most 20 hits, each a key plus a snippet |

The tool gate allows a call only when the name is a grant id. These six names are not grant ids, and `approvals.ask_first` cannot name them (`agent.ask_first_not_granted`). A call is refused with "Tool read_memory is not granted to this agent." `assets/examples/morning_digest.agent.yaml` still tells the agent to read and replace its cover, because that is the job. Before a chat-test, tell the user the gate refuses those calls, so the digest cannot read or write the memory until the check allows them. Seed the cover with `write_memory` anyway. `bash` cannot read the store either; a command that names it is blocked.

An id that is not attached returns `MEMORY_NOT_ATTACHED` from the tool, if the call is allowed.

## Caps and codes

| Cap | Value | Code |
|---|---|---|
| Cover or card | 64,000 characters | `MEMORY_TOO_LARGE` |
| Cards per memory | 200 | `MEMORY_TOO_MANY_CARDS` |
| Description | 500 characters | `MEMORY_INVALID_DESCRIPTION` |
| Card key | 1,024 characters | `MEMORY_INVALID_KEY` |

| Code | Meaning |
|---|---|
| `MEMORY_INVALID_ID` | Id shape is wrong |
| `MEMORY_EXISTS` | Create used an id that is already there |
| `MEMORY_NOT_FOUND` | No memory with that id |
| `MEMORY_MISMATCH` | The id in the file does not match the folder |
| `MEMORY_NOT_ATTACHED` | The session's agent does not list this id |
| `MEMORY_CARD_EXISTS` | `add_memory_card` on a key that exists |
| `MEMORY_CARD_NOT_FOUND` | Read, update, or delete of a missing key |
| `MEMORY_NO_PREVIOUS` | No previous cover or card |
| `MEMORY_UNREADABLE` | The file could not be read |

`agent.memory_unavailable` on validate means create the memory (or fix the id) and validate again. Enabling is refused while it is missing.

## Schedules

`schedule` on the agent starts a new session while the Host is running. It is not a pipeline trigger and it does not run stages.

```yaml
schedule:
  cron: "0 8 * * 1-5"
  timezone: Europe/London
  message: Write this morning's digest.
```

`cron` is required inside `schedule` and must parse. `timezone` is an IANA name; omitted, the Host's zone is used. `message` defaults to `Scheduled check-in.` and is the user turn of each run. The session source is `schedule`.

The Host ticks every 30 seconds (`STAGEFLOW_AGENT_SCHEDULE_TICK_INTERVAL_MS`; `0` turns the ticker off). Only an enabled agent with a `schedule` block is considered. The first tick after save or enable stores the next run and does not fire. A missed time, because the Host was down, fires once, not once per missed occurrence. Editing the cron to an earlier time replaces a stored next-run that is further out.

Ask-first tools still wait for a person. There is no channel reply unless `channel` is set; the result is on the session page (`#/agent-sessions`) and in `sf agents sessions <id>`.

A protected agent (`web_chat.access: authenticated`) needs exactly one service identity that includes this agent, or the scheduled turn fails `identity.not_available`. Setup is in [channels-and-identity.md](channels-and-identity.md#protected-chat-and-identity).

Give a scheduled agent `limits.cost_usd` and a small `max_turns`. If it has ask-first tools, tell the user it will wait.

## Always on

`limits.always_on: true` means the session does not end by `session_minutes` or `max_turns`, and it resumes after a failure. Set it for iMessage. With `always_on`, `cost_usd` is the spend in the last 24 hours, not the life of the session.

A Host restart fails in-flight turns with `agent.host_restarted` and expires pending approvals. For an always-on iMessage agent, the Host then resumes the interrupted turn and answers the same sender once. Other providers are not resumed that way.

`always_on` does not enable the agent and does not start the schedule. The Host still has to be running for either to fire.
