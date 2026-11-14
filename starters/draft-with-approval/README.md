# Draft with approval

A two-stage pipeline that stops and waits for you. The first stage drafts an announcement and asks you to approve it. The second stage starts only after you approve, and writes shorter versions for email, chat and social posts.

**What it shows**

- A human approval gate: the `draft` stage calls `ask_operator` with the draft file and waits. The run shows up in your Inbox.
- `verify` with `type: gate`: the stage cannot finish until you approve. If you reject it or ask for changes, the stage revises the draft and asks again.
- A handoff between stages: `adapt` reads the approved text from `draft`'s output (`announcement`).

**Try it**

Run the `draft-with-approval` pipeline with the `draft-with-approval` task. When the run waits, open the gate, read `draft.md`, and either approve it or reject it with a note such as "make it friendlier". After you approve, `adapt` writes `versions.md`.

**Make it yours**

Change `subject`, `audience` and `key_facts` in the task. The same pattern works for release notes, policy updates, customer emails or anything else a person should check before it goes further.
