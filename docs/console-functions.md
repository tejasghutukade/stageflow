---
layout: default
title: Console - Functions
---

# Functions in the console

What a function is, how its code and access work, and how to attach it: [Functions](functions.md). This page covers the screens. Functions are under **Build** in the rail.

| Route | Page |
|-------|------|
| `#/functions` | The directory |
| `#/functions/new` | Create a function. Add `?kind=verification`, `routing` or `tool` to preselect a kind |
| `#/functions/<id>` | The editor for one function |

## Directory (`#/functions`)

One row per function. Click a row, or move with **↑ / ↓** and press **Enter** or **Space**, to open it. **New function** creates one.

| Column | Meaning |
|--------|---------|
| **Function** | The name, its id beside it when they differ, the description, and in amber the first problem if the file has any (with a count when there are several) |
| **Kind** | **Verification**, **Routing** or **Tool** |
| **Revision** | The current revision number |
| **Updated** | How long ago, for example `9m ago`. Hover for the exact time |

Filter chips: **All**, **Verification**, **Routing**, **Tool**, each with a count. The search box matches the name, the id and the description. **Clear filters** appears when nothing matches.

Hover a row to show its delete icon. **Delete** asks first. If a pipeline, reusable stage or agent still uses the function, the dialog lists those places instead and does not delete anything.

With no functions yet, the page lists the three kinds, what each is for, and links that open the editor with that kind selected.

## Create (`#/functions/new`)

1. **Kind.** Pick one of the three cards. The starter code changes with the kind. It cannot be changed after you create the function.
2. **Name.** The **Id** fills in from the name as you type. Edit it if you want something else. It is fixed once the function is created.
3. **Description** and **Timeout** are optional (5000 ms by default, 1 to 30 000).
4. Write the code, set the access, and choose **Create function** (or press **⌘S** / **Ctrl+S**).

The starter code begins with an `export const access = { ... }` block so the syntax is in front of you.

## The editor (`#/functions/<id>`)

The header shows the name, the kind, `Revision N`, **Duplicate** and **Save as revision N+1**. **Duplicate** asks for a new id and copies the function with its own history.

The bar under the header tells you where you stand:

- **No unsaved changes**, or **N unsaved changes** with the sections you touched, and **Discard changes**.
- **Ready to save**, or **N to fix** with the problems listed in the page. A problem in a field shows under that field. Anything else shows in a box at the top.
- A conflict: **This function is now at revision N. Reload to see it; your unsaved edits will be dropped.** Your edits stay on screen until you choose **Reload**, so you can copy them out.

The left nav jumps to a section and shows a dot on each section you changed. **Delete function** at the bottom of the nav asks to confirm, and lists where the function is used if it cannot be deleted. The browser warns before you leave with unsaved changes.

### Details

Name, id (read-only after creation), description, timeout and kind.

### Source

A JavaScript editor with highlighting. Errors from the Host appear under it. If the editor cannot load, a plain text box takes its place.

### Access

Access is an editable view of the `access` block at the top of the source. A summary line reads like `Read artifacts · Env MIN_SCORE · API https://api.example.com (read)`.

| Control | What it does |
|---------|--------------|
| **Artifacts** | **None**, **Read**, or **Read and write**. Write is offered only for tools |
| **Workspace** | The same, for the whole workspace. It is broad. Leave it on **None** unless the function needs it |
| **Environment variables** | One row per name, with a **Required** switch. A name that is not required is written with a trailing `?` |
| **Network** | One row per origin, with **Read** or **Action** (tools only) and an optional credential reference |

The controls and the code stay in step. Changing a control rewrites only the `access` block in the source and leaves the rest alone. Typing in the source updates the controls. Path-scoped file entries (`files: [...]`) are shown read-only under **Advanced access**. Edit them in the code, and they are kept when you change other controls.

If the block has a problem, the section shows the message with its line and column, and the controls become read-only so your text is not rewritten. Fix it in the source.

A function that still has explicit `capabilities` and no `access` block keeps its old controls. **Move access into the source** writes an `access` block from them. Capability ids are derived from the code afterwards, so each attachment asks you to review once.

When you change access on a saved function, a note reminds you that attachments which do not grant the new access will fail validation until you update their grants.

### Tool interface

Tools only. **Tool name** (the name the model calls), **Tool description**, **Input schema** and an optional **Output schema**, as JSON. The schema fields show their own error if the JSON is not an object. While you create a tool, the tool name follows the id and the description follows the description until you edit them.

### Test

- **Use real files, environment, and APIs.** Off by default and not remembered. When on, the run touches real artifacts, workspace, environment values and APIs, including any action you granted.
- **Sample context.** The JSON becomes `context`, filled in for the kind: `{ "input": {} }` for a tool, an envelope and children for routing, an empty object for verification. The hint under the box says what the kind receives.
- **Run test.** It needs a saved function. The line beside the button says whether it runs the saved revision or your unsaved source, which is never saved by testing.

A result shows **Succeeded**, **Failed · code** or **Uncertain · code**, the time in milliseconds, the revision (or "Unsaved source"), the message, the result JSON and the logs. The panel does not send mock files or environment values. A function that needs one fails with `missing_fixture` or `missing_binding`. Use the [API](function-api.md#test) for those, or turn real resources on.

### History

The most recent tests and real calls, each with its status, code, kind, revision, duration and age.

## Attaching a function

A function does nothing until a stage or an agent attaches it.

**On a stage.** Open the pipeline (`#/pipelines/<id>`), select a stage, and find the **Functions** panel in the inspector. It has three slots: **Checks** (verification functions), **Tools** and **Route function** (one routing function). Choose a function from a slot's list, or drag it from the row of chips below onto a slot. A function of the wrong kind is refused with a link to its definition. **Manage** opens the Functions page.

**On an agent.** In an agent's **Edit** page under **Tools and access**, the **Functions** control attaches tool functions.

Adding a function that needs access first shows what it wants, for example *Total counts wants: Read artifacts report.md, API https://api.example.com (read), Env FEED_REGION*. **Allow** attaches it with exactly those grants. **Cancel** attaches nothing. A function that needs no access attaches at once.

After you change a function's access, its attachments show **Access changed** and **Review**. **Review** opens the same prompt, and **Allow** updates only that attachment's grants. An attachment whose function has been deleted shows **Not found**.

The Workshop's stage inspector does not include the Functions panel. Use the pipeline page, or edit the YAML ([Attaching a function](functions.md#attaching-a-function)).

## Keyboard

| Where | Keys |
|-------|------|
| Directory | **↑ / ↓** move the cursor · **Enter** or **Space** open |
| Editor | **⌘S** / **Ctrl+S** save · **Esc** closes a dialog |
