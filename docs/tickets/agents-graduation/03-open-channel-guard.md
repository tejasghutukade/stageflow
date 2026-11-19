# 03: Save-time guard for open channels with tools

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** —

## Why

A channel agent runs with every granted tool and no per-sender check. With `allow_from: ["*"]` anyone who can reach the address can drive MCP tools, `bash`, functions and shared memories. Today this only yields the informational `agent.channel_open_to_anyone`. This is the stopgap until phase 2.

## Read first

- `src/agents/consumerSafety.ts` (`isConsumerSafeAgent`), `src/agents/service.ts` (where `agent.channel_open_to_anyone` and `agent.channel_nobody_allowed` are produced), `src/config/loadAgent.ts`.
- How the console shows agent issues and "Needs setup".

## What to build

1. New error finding `agent.channel_open_with_tools`: the channel allows `*` or a public mail domain (see Decisions made) and the agent is not `isConsumerSafeAgent`. Saving is allowed; **enabling** is refused, and an already-enabled agent in this state shows "Needs setup" and its channel stops answering.
2. The message says what to do: list the senders, or remove tools, memories and project context.
3. Console: show the finding on the agent page and in the editor's channel section.
4. Docs: `docs/agents.md`, `docs/agent-definition.md` (finding table), channel guides.

## Acceptance

- [ ] `*` + any tool, memory, skill, function, browser, project context or sub-agent → cannot enable (test per capability).
- [ ] `*` + tool-less agent → still allowed, existing info finding kept.
- [ ] Explicit sender list + tools → allowed.
- [ ] `@gmail.com` + tools → cannot enable; `@acme.com` + tools → allowed.
- [ ] Existing enabled agents in the bad state stop answering on the channel after upgrade, and the changelog says so.

## Decisions made (2026-11-16, do not revisit)

- A company `@domain` entry is not open. A public mail domain is: `@gmail.com`, `@outlook.com`, `@hotmail.com`, `@yahoo.com`, `@icloud.com`, `@proton.me` and the like count as `*` for this guard. Keep the list in one exported constant with a test; it is known to be incomplete, and the docs say so.
- No grace release. After upgrade an already-enabled agent in this state shows "Needs setup" and its channel stops answering until the senders are listed or the tools, memories and project context are removed. The changelog entry leads with this.

Example that must be refused on enable:

```yaml
channel:
  connection_id: support-inbox
  allow_from: ["*"]            # or ["@gmail.com"]
tools:
  mcp:
    shopify: [get_order, refund_order]
```

`allow_from: ["@acme.com"]` with the same tools is allowed.

## Outcome

Done in 0.66.0. No console change was needed beyond what issues already show (Needs setup, the finding in the editor); not checked in a running console.
