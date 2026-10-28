import type { GuideKnowledgeTopic } from "../index.js";

export const memoriesTopic: GuideKnowledgeTopic = {
  id: "memories",
  title: "Memories: durable notes for pipelines and agents",
  summary:
    "Host memories with a cover page and keyed cards, attaching them to a pipeline or an agent, which memory tools a session gets, size caps, and what cannot be changed or deleted.",
  body: `# Memories

A memory is a named store on the Host (\`$STAGEFLOW_HOME/memories/<id>/\`). It survives runs and conversations. It has:

- a **cover page** (\`body.md\`): one free-text page, replaced as a whole;
- **cards**: keyed notes, one per subject (a person, a ticket, a release, a path). The key is the subject's own id (an email, a ticket number, a version), 1 to 1024 characters.

A memory also has an \`id\` (\`[a-z][a-z0-9_-]{0,63}\`) and a \`description\` (1 to 500 characters) set at creation.

## Create and attach

1. Create the memory first: console **Memories**, or \`create_memory\` with \`id\` and \`description\`. The cover starts empty.
2. Attach it:
   - to a **pipeline** with the top-level \`memories: [id]\` list (tool: \`edit_pipeline\` with \`patch: { memories: [...] }\`; an empty list removes it). Every stage in that pipeline gets it. A stage cannot list memories of its own (\`pipeline.invalid_shape\`).
   - to an **agent** with its \`memories: [id]\` field (tool: \`save_agent\`). Sub-agents do not inherit it.
3. A missing, unreadable or mismatched id blocks validation and run start (\`pipeline.memory_unavailable\`) or agent save and enable (\`agent.memory_unavailable\`). A duplicate id in the list is \`pipeline.invalid_memories\`.

## What a session gets

A stage of a pipeline with memories (Pi backend) and every session of an agent with memories get six tools:

- \`read_memory\`, \`replace_memory\` for the cover;
- \`add_memory_card\` (refuses a key that exists), \`update_memory_card\` (refuses a key that is missing), \`read_memory_card\`, \`search_memory_cards\` (case-insensitive word scan of keys and bodies, at most 20 hits, key plus snippet).

The prompt lists only the memory ids and descriptions, not the cover or card text; the session must read them with the tools. The session never gets a file path, and Pi stages with memories are blocked from reaching the memory store through the shell. A session cannot delete a card and cannot read a previous copy. The Claude backend has no memory tools: a pipeline with \`memories\` fails at stage start there.

## Caps

- Cover and each card: at most 64,000 characters. A larger write is refused (\`MEMORY_TOO_LARGE\`).
- At most 200 cards per memory (\`MEMORY_TOO_MANY_CARDS\`).
- Two cover replacements at the same time: the last write wins.
- One previous copy of the cover and of each card is kept, not a full history, and there is no restore action.

## What people and tools can do

| Action | Session (stage or agent) | Operator in console | Guide / operator tools |
|---|---|---|---|
| Create a memory | no | yes | \`create_memory\` |
| Read cover and card keys | yes | yes | \`get_memory\`, \`list_memories\` |
| Replace the cover | yes | yes | \`write_memory\` |
| Add a new card | yes | no | no |
| Replace an existing card | yes | yes | \`write_memory_card\` (refuses a missing card) |
| Delete a card | no | yes (also removes its previous copy; cannot be undone) | \`delete_memory_card\` (destructive) |
| Change the description | no | no | no |
| Delete a whole memory | no | no | no |

So cards are written by the sessions that do the work. To seed facts before the first run, put them on the cover page, or let the first run add cards.

## Memory or task context?

- Facts for one run go in the task (\`context\`, \`constraints\`, \`input\`).
- Facts that must persist and be updated across runs or conversations go in a memory: contacts already messaged, per-customer notes, release history.
- Name the memory and write a clear description: it is all the session sees before it calls a tool.

## Error codes

\`MEMORY_INVALID_ID\`, \`MEMORY_INVALID_DESCRIPTION\`, \`MEMORY_INVALID_KEY\`, \`MEMORY_EXISTS\`, \`MEMORY_NOT_FOUND\`, \`MEMORY_NO_PREVIOUS\`, \`MEMORY_CARD_EXISTS\`, \`MEMORY_CARD_NOT_FOUND\`, \`MEMORY_TOO_MANY_CARDS\`, \`MEMORY_MISMATCH\`, \`MEMORY_UNREADABLE\`, \`MEMORY_TOO_LARGE\`, \`MEMORY_NOT_ATTACHED\`.
`,
};
