# 01: Route Bash calls into a container via toolAliases

**What to build:** A `sandbox_bash` MCP tool (in `src/agent/claudeTools.ts`, same `tool(name, description, shape, execute)` pattern as `emit_stage_envelope`/`write_stage_artifact`) whose `execute` runs `docker exec <container> bash -c "<command>"` and returns stdout/stderr/exit code. Wire it into `claudeAdapter.ts`'s `query()` call via `toolAliases: { Bash: 'mcp__stageflow__sandbox_bash' }` alongside the existing `tools: CLAUDE_BUILTIN_TOOLS`. `Read`/`Write`/`Edit` are untouched — the SDK's own built-ins keep operating on the host filesystem.

**Blocked by:** None (can start immediately)

**Status:** done — implemented, code-reviewed, and verified (typecheck clean, full suite green)

- [x] `sandbox_bash` tool exists in `buildStageflowMcpServer`'s tool list (`src/agent/claudeTools.ts`), accepting a command string and the target container name, returning stdout/stderr/exit code as MCP tool-result text.
- [x] `claudeAdapter.ts`'s `query()` options include `toolAliases: { Bash: 'mcp__stageflow__sandbox_bash' }` whenever `input.roots.containerName` is set, so an agent `Bash` call is transparently redirected to the sandbox tool for that attempt.
- [x] `Read`/`Write`/`Edit` calls are unaffected — no alias touches them, `tools: CLAUDE_BUILTIN_TOOLS` is unchanged either way.
- [x] `tests/runtime.sandboxContainer.test.ts` (fake-docker-binary, `tests/fixtures/fakeSandboxDocker.mjs`) proves `execInSandboxContainer` reaches `docker exec <name> bash -c <command>` with the command as a single argv element (argument-injection safe), including a regression test that a real spawn failure (bad `dockerBin`) throws instead of being misreported as a fake exit code — a code-review finding fixed during this pass.
- [x] `ANTHROPIC_API_KEY` is never referenced anywhere in `sandboxContainer.ts`/`claudeTools.ts`'s new code — asserted by a dedicated test reading the source file.
