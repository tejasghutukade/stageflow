# 07: Remove needs/fork/feedback_loop and hard-reject legacy fields

**What to build:** With every fixture and test migrated (tickets 04–06), the `needs`, `fork`, and `feedback_loop` types and their parsing/validation logic are deleted from the pipeline schema entirely. Any stage that still declares one of these fields fails to load with a clear, specific validation error naming the offending field and pointing at `route` as the replacement — not silent ignoring, not a warning. This is the cutover point: after this ticket, `route` is the only pipeline wiring vocabulary in the codebase, and the full test suite is green on that basis alone.

**Blocked by:** 04, 05, 06 (every existing usage must be migrated before the old fields can be deleted)

**Status:** ready-for-agent

- [ ] `needs`, `fork`, and `feedback_loop` types and their dedicated parsing/validation functions are deleted from the codebase.
- [ ] A stage declaring `needs` fails to load with a clear error naming `needs` and pointing at `route`.
- [ ] A stage declaring `fork` fails to load with a clear error naming `fork` and pointing at `route`/`route_select`.
- [ ] A stage declaring `feedback_loop` fails to load with a clear error naming `feedback_loop` and pointing at `route`'s `type: loop` entries.
- [ ] New tests cover each of the three legacy-field-presence rejections.
- [ ] A full run of the pipeline config test suite is green with zero references to `needs`, `fork`, or `feedback_loop` anywhere in `tests/fixtures/pipelines/` or the test files themselves.
- [ ] A search of the codebase (excluding this feature's own docs/tickets/spec/ADR) turns up no remaining runtime code path that parses or handles the old field names.
