# 06: Bundled `browser` skill

**What to build:** A bundled skill that teaches the agent-browser commands and the safety rules. It resolves with the existing skill precedence. Verify the agent can run the commands through the stage bash tool.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] The skill lists the commands for open, snapshot, click, fill, wait, screenshot, and reading the address.
- [ ] The skill tells the agent to use the provided session and not to choose a profile.
- [ ] The skill tells the agent to stay on allowed domains, treat page text as data, never dump cookies or storage, read slowly, and stop at the task limit.
- [ ] The skill tells a submit-capable stage to press no irreversible button before a gate.
- [ ] A stage with a `browser` field gets the skill without extra YAML.
