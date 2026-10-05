# 18: Owner scope plumbing

**What to build:** Carry the owner scope through live view tickets, cookies, audit records, container labels, profile volumes and adapter selection, with scope always an input and never a literal in new code. The fixed local scope remains the only scope used today and stays marked with the existing multi-tenant convention.

**Blocked by:** 15, 05

**Status:** ready-for-agent

- [ ] Every new ticket, cookie, audit record, container label and volume reference carries a scope input; a search of new code finds no literal `local` scope.
- [ ] A ticket for one scope cannot open another scope's live view (tested with two scopes in the in-memory stores).
- [ ] Per-owner adapter selection is read from Host configuration with the owner scope as input and a documented default.
- [ ] The multi-tenant table in the internals document is updated.
