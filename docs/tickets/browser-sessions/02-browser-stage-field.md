# 02: `browser` stage field (load, validate, requires)

**What to build:** Accept `browser` on a pipeline stage entry and in an external stage file, with pipeline-entry override. Validate the shape. Map it into the loaded stage config. Add the agent-browser requirement automatically. Document the field in the catalog.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Valid fields: profile name (optional), headed flag, allowed domains, login check (address, logged-in pattern, logged-out patterns).
- [ ] Unknown keys, bad names, and bad domain lists fail load with a clear error code.
- [ ] A path or scope in the field is rejected.
- [ ] `sf validate` fails with a distinct error when agent-browser is not on the path.
- [ ] A pipeline-entry value overrides a stage-file value, as with `skill` and `mcp`.
- [ ] Fixture YAML covers valid and invalid cases.
