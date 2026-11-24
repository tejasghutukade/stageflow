/**
 * What an archive holds, as one table. It mirrors the layout table in docs/data-directory.md; a test fails when a path
 * documented there has no rule here. A top-level entry of the data directory that no rule names is left out (and said so in
 * the manifest), so a file a later release adds is never copied by accident.
 */
export type ArchiveRuleKind =
  | "copy" // a file or a folder, copied as is
  | "database" // a SQLite file, copied consistently with VACUUM INTO
  | "secret" // a file or folder that holds secrets; copied only when the caller asks
  | "redacted" // a file that mixes routing with credentials; copied without the credentials unless the caller asks for secrets
  | "never"; // disposable or rebuilt; never copied

export type ArchiveRule = {
  /** Path under the data directory, with `/` separators. A trailing `/` means the folder and everything in it. */
  path: string;
  kind: ArchiveRuleKind;
  reason: string;
  /** Rules with the same group are copied together or left out together. */
  group?: string;
  /** Only with `--include-a2a-artifacts`. */
  optIn?: "a2a-artifacts";
};

export const ARCHIVE_RULES: readonly ArchiveRule[] = [
  { path: "state.db", kind: "database", reason: "run store" },
  { path: "settings.json", kind: "copy", reason: "global settings" },
  { path: "workspace/", kind: "copy", reason: "workspace catalog" },
  { path: "memories/", kind: "copy", reason: "memories" },
  { path: "artifacts/", kind: "copy", reason: "Published artifacts" },
  { path: "connections.yaml", kind: "copy", reason: "channel connections (references, never secret values)" },
  { path: "a2a.yaml", kind: "copy", reason: "A2A configuration (never a token)" },
  { path: "mcp/.mcp.json", kind: "copy", reason: "MCP servers added in Settings (references, never token values)" },
  { path: "agents/pi-sessions/", kind: "copy", reason: "agent conversation transcripts" },
  { path: "workshop/builds/", kind: "copy", reason: "Workshop drafts" },
  { path: "workshop/sessions/", kind: "copy", reason: "Workshop chats" },
  { path: ".stageflow/channel-sends.json", kind: "copy", reason: "channel send ledger" },
  { path: "identity/consumer-identity.db", kind: "database", reason: "consumer identity database" },
  { path: "identity/settings.json", kind: "copy", reason: "consumer identity settings" },
  { path: "agent/auth.json", kind: "secret", reason: "provider credentials" },
  { path: "agent/models.json", kind: "redacted", reason: "model routing and provider pins; keys and headers are removed unless secrets are included" },
  { path: "channel-secrets.json", kind: "secret", reason: "secrets typed into Connections" },
  { path: "identity-secrets.json", kind: "secret", reason: "identity credentials and signing key" },
  { path: "secrets/mcp-secrets.json", kind: "secret", reason: "values behind MCP ${NAME} references" },
  { path: "secrets/mcp-oauth.key", kind: "secret", reason: "key for the MCP sign-in store", group: "mcp-oauth" },
  { path: "agent/mcp-oauth-encrypted", kind: "secret", reason: "MCP sign-ins (useless without the key)", group: "mcp-oauth" },
  { path: "agent/mcp-cache.json", kind: "never", reason: "rebuilt by Check" },
  { path: "agent/", kind: "secret", reason: "other Host agent files may hold keys, so they follow the secret rule" },
  { path: "secrets/", kind: "secret", reason: "other secret files" },
  { path: "a2a-artifacts/", kind: "copy", reason: "A2A artifact bytes", optIn: "a2a-artifacts" },
  { path: "eval-engine/", kind: "never", reason: "re-installable" },
  { path: "eval-runs/", kind: "never", reason: "work directory of an eval run" },
  { path: "repos/", kind: "never", reason: "re-clonable cache" },
  { path: "worktrees/", kind: "never", reason: "re-creatable checkouts" },
  { path: "cache/", kind: "never", reason: "rebuilt" },
  { path: "tmp/", kind: "never", reason: "scratch space" },
  { path: "backups/", kind: "never", reason: "earlier backups and archives" },
  { path: "restore-pending/", kind: "never", reason: "a restore in progress" },
  { path: "workshop/autosave/", kind: "never", reason: "older Workshop autosaves" },
  { path: "host.lock", kind: "never", reason: "belongs to the running Host" },
  { path: "host-id", kind: "never", reason: "identifies this directory; read for the manifest only" },
  { path: "service.log", kind: "never", reason: "log" },
];

/** Never copied from inside a run's workspace: the stage agent's own directory and any credentials file. */
export function isDeniedRunPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.includes(".pi-agent") || segments[segments.length - 1] === "auth.json" || segments.includes("node_modules") || segments.includes(".git");
}

/** The rule that names `relativePath`: the most specific one (an exact file, or the longest folder prefix). */
export function ruleFor(relativePath: string): ArchiveRule | undefined {
  let best: ArchiveRule | undefined;
  for (const rule of ARCHIVE_RULES) {
    const folder = rule.path.endsWith("/");
    const matches = folder ? relativePath.startsWith(rule.path) || `${relativePath}/` === rule.path : relativePath === rule.path;
    if (matches && (best === undefined || rule.path.length > best.path.length)) best = rule;
  }
  return best;
}

/** True when some rule is about this path or something inside it. Used to walk only the folders that matter. */
export function ruleMentions(folderPath: string): boolean {
  const prefix = `${folderPath}/`;
  return ARCHIVE_RULES.some((rule) => rule.path.startsWith(prefix) || rule.path === folderPath || (rule.path.endsWith("/") && prefix.startsWith(rule.path)));
}
