---
status: reference
---

# Design handoff: Connections screens

Companion to [connections-spec.md](connections-spec.md) and [connections-provider-reference.md](connections-provider-reference.md). Read the spec first.

## Where the designs live

Wonder (design tool, reachable through the Wonder MCP plugin).

- File: **Welcome to Wonder**, file ID `01a10d0c-ed89-7a34-ac9e-b8edd0c271ca`
- Page: **Page 1**, page ID `01a10d0c-ed8b-7da6-9e8d-e66daac1c0cd`
- Organization: `tejas-ghutukade`

The file also holds the rest of the Stageflow console designs (Inbox, Runs, Run Detail, Pipelines, Triggers, Tasks, Catalog, Workshop, Agents, and more). The Connections screens were built by copying the **Page - Agents - Directory** artboard, so sidebar, header, table and footer match that shell.

To read a screen with the Wonder MCP: `get_element_code` with the artboard ID, then `take_screenshot` to see it. Large artboards exceed one response, so read subtrees by ID (use `find_elements` with a label query, or `get_element_tree` with a `depth`).

## Artboards

All are 1440 px wide, dark theme. IDs are Wonder `data-node-id` values and can change if someone duplicates or replaces an artboard. Re-check with `get_artboards` if one is missing. Positions are canvas coordinates.

| Artboard label | ID | x, y | What it shows |
| --- | --- | --- | --- |
| Page - Connections Overview | `gym` | 0, 5300 | The page. Sidebar with **Connections** active under Automate. Communication table, WhatsApp and Telegram "not connected" tiles, Tools cards, footer. |
| Page - Add Connection Picker | `mam` | 1540, 5300 | Modal over the dimmed overview. Search, Communication group (5 providers), Tools group (GitHub, Notion, Browse MCP registry, Custom MCP server), Photon footer note. |
| Page - Connect AgentMail Dialog | `lcd` | 3080, 5300 | API key, create-or-existing inbox, WebSocket or webhook, assign agents. |
| Page - Connect Slack Dialog | `why` | 4620, 5300 | Three setup steps (manifest, app-level token, bot token), detected workspace, Stageflow routing. |
| Page - Connect iMessage Dialog | `bad` | 6160, 5300 | **Photon Cloud** mode: Photon project ID and secret, read-only "Phone lines" card, assign agent. |
| Page - Connect iMessage This Mac Dialog | `who` | 6160, 6600 | **This Mac** mode: requirements (this Mac, Full Disk Access), what works and what does not, assign agent. |
| Page - Connect WhatsApp Dialog | `may` | 7700, 5300 | **Through Photon**: saved Photon project, prerequisite note, numbers on the project each with an agent select. |
| Page - Connect WhatsApp Own Meta App Dialog | `our` | 7700, 6600 | **Your own Meta app**: phone number ID, access token, app secret, Meta webhook instructions, assign agent. |
| Page - Connect Telegram Dialog | `sen` | 9240, 6600 | Bot token, saved Photon project, optional webhook secret, assign agent. |
| Page - Connection Detail AgentMail | `sny` | 9240, 5300 | Detail page: header with status, agents on this inbox, recent conversations linked to runs, side panel (inbox, incoming mail, credential, disconnect). |

Dialog artboards sit on top of a copy of the overview (dimmed). That copy is only a backdrop. The dialog is the design. Dialog artboards are 1000 px tall minimum so taller dialogs are not clipped. That is a canvas artefact, not a layout rule.

## Screen details and component notes

### Overview (`gym`)

- Page header: breadcrumb "Connections", title, one-line description, primary button **Add connection** (top right).
- **Communication channels** section: heading, subheading, "N connected" count. Table columns: Connection (icon tile, name, mono secondary line), Agents (chips, `+N` overflow), Status (icon plus text), Last message (relative time, mono), chevron. Rows are clickable to the detail page.
- Below the table, dashed "available" tiles for channels not connected yet (here: WhatsApp Business, Telegram), each with a **Connect** button. A provider appears here only while it has no connection. Open question for implementation: whether a provider with one connection should still be offered for a second.
- **Tools** section: a four-column grid of cards (icon tile, name, status, "Used by N agents · N tools"), a **Needs setup** card with an amber border, and a dashed "Add a tool from the MCP registry" row.
- Footer note: totals, for example "7 connections · 3 channels · 4 tools · 1 needs attention". Footer action hint: "↑ ↓ to move · ↵ to open · N add". Keyboard handling is not designed beyond this hint. Follow the existing page pattern.
- Status vocabulary: **Connected** (green check), **Needs setup** (amber warning). Disabled is not designed. Do not add a warning state that has no real documented cause (see spec: Photon tokens auto-renew).

### Add connection picker (`mam`)

- Two groups. Communication heading: "Communication · talk to an agent". Tools heading: "Tools · give an agent capabilities".
- Photon-backed options (iMessage, WhatsApp Business, Telegram) carry a small "Photon" tag. Footer explains they share one Photon project so credentials are entered once.
- "esc to close" hint. Focus and keyboard behaviour not designed.

### Provider dialogs (shared anatomy)

Every dialog: 600 px wide, header (icon tile, title "Connect X", one-line subtitle, close), form body, footer (**Test connection** left, **Cancel** and primary action right). Secret inputs show a key icon, masked value, and a green check once validated. Labels are 13 px medium, hints are 12 px in the tertiary text colour. Copy in each dialog is deliberate. Keep wording close to the design unless a provider doc requires a change.

- **AgentMail:** primary button "Create inbox and connect". The inbox row is `username @ domain` with the domain selected from the verified domains (default `agentmail.to`). Incoming mail is a two-card choice (WebSocket default, Webhook).
- **Slack:** primary "Connect Slack", footer secondary "Send test message". Step 1 shows a manifest summary with **Copy manifest** and an **Open api.slack.com/apps** link. The manifest block in the design is a summary. The real manifest must be a complete, valid Slack app manifest generated by Stageflow (name, bot user, scopes, events, `socket_mode_enabled: true`). Steps 2 and 3 are single-line secret inputs. Step 3 shows "Detected workspace ... · bot @..." after the token is verified.
- **iMessage (cloud):** the mode toggle (Photon Cloud, This Mac) is a two-card choice. Project ID is plain text, secret is masked. "Phone lines" is read-only and derived from the Photon token endpoint's `shared` or `dedicated` type. It must not be an input.
- **iMessage (This Mac):** same shell, This Mac card selected. A requirements list with a status per row, for example "Full Disk Access ... Not granted" in amber. If detection of Full Disk Access is not possible from the Host, show the instruction without a status. The primary button is "Connect this Mac".
- **WhatsApp (Photon):** the Photon project row is a saved credential with "Use another project". Numbers list comes from the project's WhatsApp lines and each row has an agent select. One row in the design is "No agent yet" to show the optional case.
- **WhatsApp (own Meta app):** copyable callback URL `https://whatsapp-business.spectrum.photon.codes/webhook`, verify token note, subscribe-to `messages`. The design has one phone number per connection in this mode.
- **Telegram:** bot token validated live ("Bot found: @name"), saved Photon project, optional webhook secret, agent select. Note under the Photon row says the webhook is registered automatically at startup.

### Detail page (`sny`, AgentMail)

- Header: breadcrumb "Connections > AgentMail", mono title (the address) with a status pill, subtitle "AgentMail inbox · Communication channel · Last email 4 min ago", buttons **Test connection** and **Pause**.
- Main column: **Agents on this inbox** (name, model line, rule text, 7-day thread count, **Assign agent** button) and **Recent conversations** (thread subject, sender and message count, agent, linked run with state, relative time).
- Side panel (340 px): Inbox (address, display name, domain), Incoming mail (mode, streaming status, last health check), Credential (masked key tail, **Replace key**, "Stored on this host. Never written to YAML."), Disconnect (**Disconnect inbox**, red outline, copy says the AgentMail inbox itself is not deleted).
- **Only AgentMail has a detail design.** Slack, iMessage, WhatsApp and Telegram need the same shell with provider-specific side-panel rows (for example workspace and bot for Slack, lines and plan for iMessage, numbers for WhatsApp, bot username for Telegram). Do not invent a different layout.

## Tokens and styling

Wonder holds these file tokens (`cssVar` form). The designs use them everywhere. Map each to the console's token or CSS-class equivalent in `ui/src/console.css` and Astryx. Do not copy Wonder class names into the repo.

| Wonder token | Value | Use |
| --- | --- | --- |
| `--sf-ground` | `#0c0d0f` | Page background |
| `--sf-panel` | `#131418` | Cards, tables, dialogs |
| `--sf-raised` | `#1a1c21` | Chips, icon tiles, selected options |
| `--sf-rail` | `#08090a` | Sidebar |
| `--sf-active` | `#16171b` | Active nav item |
| `--sf-text-1` / `-2` / `-3` | `#ecedee` / `#a7aab2` / `#8b8f98` | Primary, secondary, tertiary text |
| `--sf-hairline` / `-strong` | `#ffffff12` / `#ffffff1a` | Borders |
| `--sf-ok` | `#4cc38a` | Connected, valid |
| `--sf-needs` | `#f5b544` | Needs setup, warnings |
| `--sf-fail` | `#f2645a` | Disconnect, errors |
| `--sf-running` | `#6ca6ff` | Running, selected-option accent |
| `--sf-font-ui` | Geist | UI text |
| `--sf-font-mono` | Geist Mono | Addresses, IDs, tokens, counts |

Conventions in these screens: 13 px body text, 12 px hints, 11 px uppercase table heads with wide tracking, 15 px section headings, 24 px page title. Addresses, IDs, counts and times are monospace.

## Icons

The designs use Feather-style line icons (react-icons `fi`): mail (AgentMail), hash (Slack), message-circle (iMessage), phone (WhatsApp), send (Telegram), github, book (Notion), alert-circle (PagerDuty), search (Dovetail), link (Connections nav), check, alert-triangle, chevron-right, copy, key, lock, info, zap. These are **placeholders, not brand logos**. Provider logos are not used on purpose. Do not add third-party brand marks without the owner's say-so. The repo console has its own icon approach (`ui/src/components/COMPONENT-MAP.md`). Use that.

## Sample data in the designs (not real)

Everything is illustrative: `research@agentmail.to`, workspace `acme-corp`, bot `@stageflow-agents`, phone numbers `+1 (415) 555-0142`, `+44 7700 900123`, `+1 415 555 0199`, Photon project ID `3f9c21aa-...`, bot `@acme_research_bot`, agents "Research assistant", "Fact checker", "Operations assistant", "Release coordinator", "Customer insights". Agent names come from the existing Agents screens in the file. Token and secret values are masked placeholders.

## Known gaps and deviations (be explicit about these when implementing)

- No empty, loading, error, disabled, or "Disconnecting" states are designed.
- No designed UI for: adding or verifying an AgentMail custom domain, replacing a Photon project's credentials, reconnecting after failure, editing an existing connection, or the Tools setup flow (picker entries only).
- The Add connection picker lists a Telegram option because Photon supports it. The owner did not originally list it. Confirm it stays in scope.
- Slack routing rows ("DMs + #ops-alerts", "#releases") and AgentMail agent rules ("Replies to every new thread", "CC'd only, never sends") are invented. See the spec's open decisions.
- Counts in the sidebar ("7") and footers are static text in the design.
- The overview's "Last message" column and detail page's "Recent conversations" assume Stageflow stores conversations per connection and links them to runs. That storage does not exist yet. See spec, Provider adapter contract.
- Photon-backed dialogs reuse a saved project ("Saved from your iMessage connection"). The first Photon connection a user makes shows the Project ID and secret inputs. The WhatsApp and Telegram dialogs in the designs show only the reuse state, not the first-time state.
- The Tools cards say "Used by N agents · N tools". "N tools" assumes a count of tool definitions exposed by each MCP server. Verify that is obtainable.
