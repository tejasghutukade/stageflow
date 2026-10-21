# 01: Owner scope and profile store

**What to build:** A profile key (scope plus name), a profile store interface with a local implementation, and an in-memory fake with two scopes. All profile path building lives in the store. Profiles are created with owner-only permissions under the Stageflow home. Delete-by-scope exists.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Profile names are validated. Path tricks and separators are rejected.
- [ ] Opening a profile creates it with owner-only permissions in the local scope.
- [ ] List and delete work for one scope and do not touch another scope.
- [ ] Delete-by-scope removes all profiles of that scope only.
- [ ] A contract suite runs against the local store and the in-memory fake.
- [ ] A test proves scope A cannot open scope B's profile by name or by path.
