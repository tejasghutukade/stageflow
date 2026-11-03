---
layout: default
title: Console - A2A
---

# A2A in the console

A2A is in the **Connect** group of the sidebar, after Identity (route `#/a2a`). It is where an operator lets other agents call published pipelines, without a file, a command or an environment variable. For the protocol, the request contract and the management API behind this screen, see [A2A](a2a.md).

| Route | Screen |
|-------|--------|
| `#/a2a` | A2A: the turn-on screen, or three tabs once A2A is on |

The console shows names, addresses and codes. A caller's token is shown once, when the caller is added, and nowhere else.

## Turn on A2A

A Host with A2A off opens on **Turn on A2A for this Host**. The card lists what it gives you: callers, published pipelines, and that turning A2A off keeps them. Press **Turn on A2A**. There is nothing to restart; the screen then opens on the tabs.

The public address is the Host's own setting (`STAGEFLOW_PUBLIC_URL`; hosted workspaces set it for you). If the Host has none, the screen says **This Host has no public address** and explains what to set, instead of showing a broken agent card address. Turn A2A on again once it is set.

Turning A2A off and on again restores the callers, published pipelines and token digests as they were. A screen opened on a Host where A2A was turned off says so (**A2A is turned off**) and the button restores them.

## The page

Once A2A is on, the page shows the **Public address** and the **Agent card address**, each with a **Copy** button, and three tabs: **Callers**, **Published pipelines** and **Status**.

### Callers

A caller is an outside agent. Type a name (1 to 80 letters, digits, `-` or `_`, starting with a letter or digit) and press **Add caller**. The page then shows the caller's token in a notice above the tabs:

- It is shown once. **Copy token** copies it; **I have copied it** removes it from the page.
- It is held only in the open page. Reloading, leaving the screen, revoking the caller or turning A2A off loses it, and no other screen, list or API reply shows it again.
- A lost token cannot be recovered: revoke the caller and add it again.

The list shows each caller and the published pipelines it may call. **Revoke…** asks to confirm. Revoking removes the caller from every published pipeline and its token stops working on its next request. A caller whose name still has saved tasks (kept 30 days after they finish) cannot be added again; use another name.

### Published pipelines

**Publish a pipeline** opens a dialog:

- **Pipeline**: choose from your catalog.
- **Name** and **Goal**: you type both. The id is made from the name (lowercase, hyphens), shown under the field, and cannot be changed afterwards. A name whose id is already taken is refused.
- **Description**: what other agents read to decide whether to call it.
- **Input schema**: pick an existing `.json` file from the pipeline's project. The console lists the project's `.json` files (at most 500, not looking inside `node_modules` or `.git`); it does not write schemas.
- **Result stage**: the pipeline's final stages. It is chosen for you when there is exactly one. A pipeline with no usable final stage (it needs one final stage and no cloning) says so.
- **Files the other agent can download**: pick from the files that stage declares.
- **Stages the caller may answer**: stages whose only question is free text. None are selected unless you tick them.
- **Include the result stage's output in the reply**: on by default.
- **Callers that may use it**: tick callers. Nothing is exposed until you tick one.
- **Preview contract** shows what the other agent will see before you press **Publish**.

The same rules the Host applies when it loads a publication decide which stages and files are offered, so a choice the dialog offers is one the Host accepts.

Each row shows the name and id a pipeline is published as, its pipeline file and the callers that may use it (**Nobody** when none is ticked). **Edit** opens a dialog:

- **Description**: what other agents read to decide whether to call it.
- **Callers that may use it**: tick the callers.
- **Preview contract**: the input schema the other agent sends, the output it gets back and the files it can download, as the Host will serve them. Preview before you save.

**Save** applies to new calls. Tasks already running keep the settings they started with. **Remove…** unpublishes a pipeline after a confirmation.

### Status

- The state, the number of callers and published pipelines, the configuration file and when it was last loaded. **Reload configuration** loads the file again; a failed load keeps the configuration already in use and shows why.
- **For the calling agent**: the agent card address, how to send the token (`Authorization: Bearer <caller token>`) and a command, each with a copy button. The snippet holds a placeholder, never a real token.
- **Turn off A2A**: asks to confirm. Other agents can no longer reach this Host over A2A; callers, published pipelines and token digests are kept.

## States

| State | What the screen shows |
|-------|-----------------------|
| Loading | **Loading…** |
| Cannot reach the Host | The error code and **Retry** |
| Off | **Turn on A2A for this Host**, or **A2A is turned off** when data is kept |
| Configuration error | The Host's message, the file path and **Reload configuration**. Other agents get an unavailable answer until it loads |
| On, no callers | The addresses and an empty **Callers** tab |
| On, with callers | The addresses and the three tabs |

Errors show a short explanation and the code, for example `a2a_caller_exists`.
