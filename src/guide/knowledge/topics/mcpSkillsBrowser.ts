import type { GuideKnowledgeTopic } from "../index.js";

export const mcpSkillsBrowserTopic: GuideKnowledgeTopic = {
  id: "mcp_skills_browser",
  title: "MCP servers, skills and browser sessions",
  summary:
    "Giving stages and agents extra tools: project MCP servers (.mcp.json and console servers, secrets, OAuth), skills (binding and install), and browser sessions (profiles, login check, human login stage, limits).",
  body: `# MCP servers, skills and browser sessions

## MCP servers

MCP servers give a stage or an agent tools in other systems (issue trackers, docs, web fetch, Playwright). Two sources, merged:

- the project \`.mcp.json\` next to \`stageflow.yaml\` (\`{ "mcpServers": { "name": { ... } } }\`);
- servers saved in the console (**Settings → Project MCP**, stored on the Host). A console server wins on a name clash. Project-file servers cannot be removed from the console.

A server is stdio (\`command\`, \`args\`, \`env\`, \`cwd\`) or http (\`url\`, \`headers\`, \`httpTransport\`). The name \`stageflow\` is reserved. Link-local and cloud-metadata URLs are refused.

**Secrets.** Tokens are moved out of the saved config into a secret store and replaced with \`\${NAME}\` placeholders. Values are write-only. Placeholders naming provider keys or Stageflow control tokens are refused unless allow-listed.

**Who fills \`\${NAME}\`:**
- Agents and the Check button: console secrets, plus Host variables named in \`STAGEFLOW_MCP_ENV_ALLOW\`.
- Pipeline stages: only console secrets the stage lists under \`secrets:\` (they fill MCP placeholders and are not put in the stage environment), plus the stage's curated environment.
- Repository-bound stages: never console servers or console secrets; they read the repository's own \`.mcp.json\`.

**OAuth.** Remote servers can be signed in from the console (copy the redirected address back into the dialog). Signed-in servers work for agents and Check only, **not for pipeline stages**; give a stage a bearer-token secret instead.

**Using it.**
- Stage: \`mcp: [linear]\` on the pipeline entry (or the stage file) plus \`secrets: [LINEAR_TOKEN]\` if needed. \`validate\` checks names and that stdio commands are on PATH; connect failures and unset variables fail at run time. Default connect timeout 30 s. Large tool results are written to an artifact file and the model sees a preview. MCP elicitation (a server asking the user a question) is not supported.
- Agent: \`tools.mcp: { linear: ["*"] }\` or a list of tool names. Grant id \`<server>.<tool>\`, usable in \`approvals.ask_first\`. Servers start lazily per session. An unknown server only warns (\`agent.mcp_server_unknown\`).
- Tools: \`list_project_mcp\` (read), \`probe_project_mcp\` (connects to the server). There is no tool to add or remove a project MCP server or set an MCP secret; that is done in Settings → Project MCP.

## Skills

A skill is an instruction bundle (\`SKILL.md\`) the agent loads.

- Stage: \`skill: <name>\` on the stage **body** (stage file or inline), not on a \`uses:\` wrapper. One skill per stage.
- Agent: \`tools.skills: [names]\`.
- Lookup order for a stage: skills shipped with the run (\`start_run.skills\`), then \`<checkout>/.pi/skills/<name>/\` (needs workspace trust for repository bindings), then the Host's Pi skills directory.
- A missing skill fails the stage before the agent starts, or fails the agent session.
- Install on the Host: console **Catalog → Skills** (Install), or \`sf skills install --from-zip <url> --skill-name <name>\`. \`list_skills\` shows name, description and origin. There is no tool to install a skill.

## Browser sessions

A stage with \`browser:\` drives a real Chrome through \`agent-browser\` (must be installed on the Host: \`npm i -g agent-browser && agent-browser install\`). The agent uses it through bash and the bundled \`browser\` skill.

- \`profile\`: a saved login on the Host. YAML names it, never a path. No profile means a throw-away browser.
- One shared browser per run and profile; each stage gets its own tab; tabs share cookies. A profile is leased to one run at a time: another run that needs it waits (no time limit) until the holder run ends.
- \`headed\` (default true) or \`false\`. Use one mode for all stages that share a profile.
- \`allow_domains\`: enforced only for stages without a profile. For profile stages it is only a prompt instruction plus an audit, not a security boundary.
- \`check\`: the Host opens \`check.url\` and decides logged in / out / unknown from \`logged_in_url\` and \`logged_out_url\` globs; the stage must emit \`{ logged_in, url }\`.
- Human login stage: \`verify: [{ type: browser_login }]\`, \`gate_kinds: [confirm]\`, \`browser.check\` set, \`headed\` not false, usually with \`on_verify_fail: { mode: repair, ... }\`. The operator logs in in a visible window or the console's live view, then confirms.
- Login pattern: check → login (only the check→login edge has \`if: logged_in eq false\`) → work, where work joins check and login with no \`if\` on its inbound edges. Putting an \`if\` on check→work silently skips work when the login stage runs.
- A Host with no screen and no live view (CLI-only run on a headless Linux) fails a login stage before the agent starts.
- **Sites that block the container's browser, and headless work.** Google and other strict sites reject the Host's own browser at sign-in. Host config (never YAML) can set \`browser.login_host: attach\` with \`browser.attach.cdp_url\`: the login stage then runs in the operator's own Chrome (a new tab, passkeys and password manager work), the Host copies the session into its own browser, and later stages run there, headless if \`headed: false\`. The Host probes the copy with the login stage's \`check\`; if the site rejects it, the profile is pinned to the operator's Chrome (\`host-hint.json\`, or \`browser.profile_hosts\`) and later stages and runs use that Chrome.
- **Author for both browsers.** Give the check stage and the login stage the same \`profile\` and the same \`check\`. Put \`headed: false\` on work stages only for sites that accept a headless browser (Indeed accepted a headed browser and rejected true headless). Give work stages that may meet a verification page \`gate_kinds: [confirm]\`. Do not assume which browser a stage got: a pinned profile runs visibly in the operator's Chrome.
- **Blocked sites escalate.** A work stage that meets a bot challenge fails with a summary that starts \`site blocked this browser:\`; it never tries to solve or disguise the challenge. The Host then pins the profile to the operator's Chrome and reruns that stage once in the same run. Do not write a stage that works around a challenge.
- **Saved logins.** Console **Connections → Browser logins** (and \`sf browser profiles\`, \`GET /api/browser/profiles\`) lists each profile with its sites, where the login was made, last login and last check, and offers Check now, Log in again, Switch back (\`sf browser unpin\`) and Delete (\`sf browser clear\`). Check now and Log in again need the stage's check recipe, saved after a stage with \`check\` has used the profile. Delete removes only the Host's copy; it does not sign out of the site.
- Passkeys, hardware keys, camera, location and notification prompts do not work; permission prompts are denied.
- \`path\`, \`scope\`, \`secret\`, \`launch_args\`, \`executable_path\` are rejected in YAML; the Host decides those.
- Many sites forbid automation in their terms. Keep volume low and stay read-only where possible.
- Agents: \`tools.browser\` is stored but not wired to anything yet.
`,
};
