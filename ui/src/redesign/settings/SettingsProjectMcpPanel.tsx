import { useEffect, useRef, useState } from "react";
import { LuPlus } from "react-icons/lu";
import {
  deleteMcpSecretValue,
  deleteProjectMcpServer,
  fetchMcpOAuthStatus,
  fetchMcpSecrets,
  fetchProjectMcp,
  fetchProjectMcpServer,
  importProjectMcp,
  postProjectMcpProbe,
  saveProjectMcpServer,
  setMcpSecretValue,
  signOutMcpOAuth,
  type McpOAuthStatus,
  type McpSecretsList,
  type ProjectMcpServerConfig,
} from "../../api";
import { McpServerForm } from "./McpServerForm";
import { McpSignIn } from "./McpSignIn";
import { configToForm, emptyMcpForm, secretsSummary, type McpFormState } from "./mcpForm";
import {
  PROJECT_MCP_SETTINGS_COPY,
  createProjectMcpSettingsSession,
  projectMcpDotToken,
  projectMcpSectionError,
  projectMcpStatusLabel,
  type ProjectMcpSettingsState,
} from "../../components/SettingsProjectMcp";
import { SettingsEyebrow } from "./SettingsSectionPanels";

export function SettingsProjectMcpPanel() {
  const sessionRef = useRef<ReturnType<
    typeof createProjectMcpSettingsSession
  > | null>(null);
  const [state, setState] = useState<ProjectMcpSettingsState>({
    loading: true,
    catalogStatus: null,
    servers: [],
    error: null,
  });

  useEffect(() => {
    const session = createProjectMcpSettingsSession({
      list: fetchProjectMcp,
      probe: postProjectMcpProbe,
    });
    sessionRef.current = session;
    setState(session.getState());
    const unsubscribe = session.subscribe(() => setState(session.getState()));
    void session.load();
    return () => {
      unsubscribe();
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, []);

  const [secrets, setSecrets] = useState<McpSecretsList | null>(null);
  const [form, setForm] = useState<{ initial: McpFormState; editing: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [oauth, setOauth] = useState<Record<string, McpOAuthStatus>>({});
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});

  // Show real status on arrival instead of waiting for a click on Check.
  const unprobed = state.loading ? "" : state.servers.filter((r) => r.status === "not-yet-probed").map((r) => r.name).join("\n");
  useEffect(() => {
    if (unprobed) void sessionRef.current?.checkAll();
  }, [unprobed]);

  const refreshSecrets = () => {
    fetchMcpSecrets().then(setSecrets, () => setSecrets(null));
  };
  useEffect(refreshSecrets, []);

  const refreshOauth = (names: string[]) => {
    for (const name of names) {
      fetchMcpOAuthStatus(name).then(
        (res) => setOauth((o) => ({ ...o, [name]: res.status })),
        () => {},
      );
    }
  };
  const remoteNames = state.servers.filter((r) => r.transport === "http").map((r) => r.name).join("\n");
  useEffect(() => {
    refreshOauth(remoteNames ? remoteNames.split("\n") : []);
  }, [remoteNames]);

  const reload = async (probe?: string[]) => {
    await sessionRef.current?.load();
    refreshSecrets();
    for (const name of probe ?? []) void sessionRef.current?.check(name);
  };
  const fail = (err: unknown) => setFormError(err instanceof Error ? err.message : String(err));

  const openAdd = () => {
    setFormError(null);
    setNotice(null);
    setForm({ initial: emptyMcpForm(), editing: false });
  };
  const openEdit = async (name: string) => {
    setFormError(null);
    setNotice(null);
    try {
      const { config } = await fetchProjectMcpServer(name);
      setForm({ initial: configToForm(name, config), editing: true });
    } catch (err) {
      fail(err);
    }
  };
  const onSave = async (name: string, config: ProjectMcpServerConfig) => {
    setBusy(true);
    setFormError(null);
    try {
      const res = await saveProjectMcpServer(name, config);
      setForm(null);
      setNotice(secretsSummary(res.secretsStored));
      await reload([name]);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const onImport = async (json: unknown) => {
    setBusy(true);
    setFormError(null);
    try {
      const res = await importProjectMcp(json);
      if (res.added.length === 0) {
        setFormError(res.errors.map((e) => `${e.name}: ${e.error}`).join(" · ") || "Nothing was added.");
        return;
      }
      setForm(null);
      const skipped = res.errors.length > 0 ? ` Skipped: ${res.errors.map((e) => `${e.name} (${e.error})`).join(", ")}.` : "";
      setNotice(`${[secretsSummary(res.secretsStored), skipped.trim()].filter(Boolean).join(" ")}` || null);
      await reload(res.added);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const onDelete = async (name: string) => {
    if (!window.confirm(`Remove ${name}? Agents or stages that use it will stop working.`)) return;
    try {
      await deleteProjectMcpServer(name);
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };
  const onSignedIn = async (name: string) => {
    setSigningIn(null);
    setNotice(`Signed in to ${name}.`);
    refreshOauth([name]);
    void sessionRef.current?.check(name);
  };
  const onSignOut = async (name: string) => {
    if (!window.confirm(`Sign out of ${name}? Agents lose access until you sign in again.`)) return;
    try {
      await signOutMcpOAuth(name);
      refreshOauth([name]);
      void sessionRef.current?.check(name);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };
  const onSetSecret = async (name: string) => {
    const value = secretDraft[name];
    if (!value) return;
    try {
      await setMcpSecretValue(name, value);
      setSecretDraft((d) => ({ ...d, [name]: "" }));
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };
  const onRemoveSecret = async (name: string) => {
    if (!window.confirm(`Remove the stored value for ${name}?`)) return;
    try {
      await deleteMcpSecretValue(name);
      refreshSecrets();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const sectionError = state.catalogStatus
    ? projectMcpSectionError(state.catalogStatus)
    : null;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <SettingsEyebrow>Project MCP</SettingsEyebrow>
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 py-0 font-sans text-[13px] font-medium text-[var(--sf-text-1)]"
          onClick={openAdd}
        >
          <LuPlus className="size-3.5" aria-hidden /> Add server
        </button>
      </div>
      <p className="font-sans text-[13px] text-[var(--sf-text-2)]">
        {PROJECT_MCP_SETTINGS_COPY}
      </p>
      {state.error ? (
        <p className="font-sans text-[13px] text-[var(--sf-fail)]">{state.error}</p>
      ) : null}
      {sectionError ? (
        <p className="font-sans text-[13px] text-[var(--sf-fail)]">{sectionError}</p>
      ) : null}
      {notice ? (
        <p className="font-sans text-[13px] text-[var(--sf-text-2)]" role="status">
          {notice}
        </p>
      ) : null}
      {form ? (
        <McpServerForm
          initial={form.initial}
          editing={form.editing}
          busy={busy}
          error={formError}
          onSave={onSave}
          onImport={onImport}
          onCancel={() => setForm(null)}
        />
      ) : formError ? (
        <p className="font-sans text-[13px] text-[var(--sf-fail)]">{formError}</p>
      ) : null}
      <div className="flex flex-col overflow-clip rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)]">
        {state.loading ? (
          <>
            <div className="flex h-14 items-center gap-3 border-b border-b-[#ffffff12] px-3.5">
              <div className="size-7 animate-pulse rounded-[7px] bg-[var(--sf-raised)]" />
              <div className="h-3 w-32 animate-pulse rounded bg-[var(--sf-raised)]" />
            </div>
            <div className="flex h-14 items-center gap-3 px-3.5">
              <div className="size-7 animate-pulse rounded-[7px] bg-[var(--sf-raised)]" />
              <div className="h-3 w-28 animate-pulse rounded bg-[var(--sf-raised)]" />
            </div>
          </>
        ) : state.servers.length === 0 &&
          (state.catalogStatus === "ok" || state.catalogStatus === "missing_catalog") ? (
          <p className="px-3.5 py-6 font-sans text-[13px] text-[var(--sf-text-3)]">
            No MCP servers yet. Add one above, or paste a snippet from the server's docs.
          </p>
        ) : (
          state.servers.map((row, index) => {
            const token = projectMcpDotToken(row.status);
            const probing = row.status === "probing";
            const last = index === state.servers.length - 1;
            const signedIn = oauth[row.name] === "authenticated";
            const canSignIn =
              row.transport === "http" &&
              !signedIn &&
              (row.status === "needs_auth" || oauth[row.name] === "expired");
            return (
              <div key={row.name} className={last ? "" : "border-b border-b-[#ffffff12]"}>
              <div className="flex h-14 items-center gap-3 px-3.5">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-['Geist_Mono',monospace] text-[13px] font-medium text-[var(--sf-text-1)]">
                    {row.name}
                  </span>
                  <span className="font-sans text-xs text-[var(--sf-text-3)]">
                    {row.transport} · {row.origin === "console" ? "added here" : ".mcp.json"}
                    {row.error ? ` · ${row.error}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2.5">
                  <span className="flex items-center gap-1.5 font-sans text-xs text-[var(--sf-text-2)]">
                    {token ? (
                      <span
                        className={`size-1.5 rounded-full${
                          token === "running"
                            ? " bg-[var(--sf-running)]"
                            : token === "succeeded"
                              ? " bg-[var(--sf-ok)]"
                              : token === "waiting"
                                ? " bg-[var(--sf-needs)]"
                                : " bg-[var(--sf-fail)]"
                        }`}
                      />
                    ) : null}
                    {projectMcpStatusLabel(row.status)}
                  </span>
                  {signedIn ? (
                    <span className="font-sans text-xs text-[var(--sf-text-3)]">signed in</span>
                  ) : null}
                  {canSignIn ? (
                    <button
                      type="button"
                      className="flex h-8 items-center rounded-lg border border-[#ffffff40] bg-[var(--sf-raised)] px-3 py-0 font-sans text-[13px] font-medium text-[var(--sf-text-1)]"
                      onClick={() => setSigningIn(row.name)}
                    >
                      Sign in
                    </button>
                  ) : null}
                  {signedIn ? (
                    <button
                      type="button"
                      className="flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 py-0 font-sans text-[13px] font-medium text-[var(--sf-text-1)]"
                      onClick={() => void onSignOut(row.name)}
                    >
                      Sign out
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 py-0 font-sans text-[13px] font-medium text-[var(--sf-text-1)] disabled:opacity-60"
                    disabled={probing}
                    onClick={() => void sessionRef.current?.check(row.name)}
                  >
                    {probing ? "Checking…" : "Check"}
                  </button>
                  {row.origin === "console" ? (
                    <>
                      <button
                        type="button"
                        className="flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 py-0 font-sans text-[13px] font-medium text-[var(--sf-text-1)]"
                        onClick={() => void openEdit(row.name)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 py-0 font-sans text-[13px] font-medium text-[var(--sf-fail)]"
                        onClick={() => void onDelete(row.name)}
                      >
                        Remove
                      </button>
                    </>
                  ) : null}
                </span>
              </div>
              {signingIn === row.name ? (
                <McpSignIn
                  name={row.name}
                  onDone={() => void onSignedIn(row.name)}
                  onCancel={() => setSigningIn(null)}
                />
              ) : null}
              </div>
            );
          })
        )}
      </div>
      {secrets && (secrets.needed.length > 0 || secrets.secrets.length > 0) ? (
        <McpSecretsSection
          secrets={secrets}
          draft={secretDraft}
          onDraft={(name, value) => setSecretDraft((d) => ({ ...d, [name]: value }))}
          onSet={(name) => void onSetSecret(name)}
          onRemove={(name) => void onRemoveSecret(name)}
        />
      ) : null}
    </div>
  );
}

function McpSecretsSection({
  secrets,
  draft,
  onDraft,
  onSet,
  onRemove,
}: {
  secrets: McpSecretsList;
  draft: Record<string, string>;
  onDraft: (name: string, value: string) => void;
  onSet: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  const stored = new Set(secrets.secrets.map((s) => s.name));
  const rows = [
    ...secrets.needed,
    ...secrets.secrets.filter((s) => !secrets.needed.some((n) => n.name === s.name)).map((s) => ({ ...s, set: true })),
  ];
  return (
    <div className="flex flex-col gap-2.5">
      <SettingsEyebrow>MCP secrets</SettingsEyebrow>
      <p className="font-sans text-[13px] text-[var(--sf-text-2)]">
        Values for the {"${NAME}"} placeholders in server configs. Stored on the Host and never shown again.
      </p>
      <div className="flex flex-col overflow-clip rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)]">
        {rows.map((row, index) => (
          <div
            key={row.name}
            className={`flex min-h-14 flex-wrap items-center gap-3 px-3.5 py-2${
              index === rows.length - 1 ? "" : " border-b border-b-[#ffffff12]"
            }`}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-['Geist_Mono',monospace] text-[13px] font-medium text-[var(--sf-text-1)]">{row.name}</span>
              <span className="font-sans text-xs text-[var(--sf-text-3)]">
                {row.usedBy.length > 0 ? `used by ${row.usedBy.join(", ")}` : "not used by any server"} ·{" "}
                {row.set ? (stored.has(row.name) ? "stored" : "set on the Host") : "missing"}
              </span>
            </span>
            <input
              type="password"
              autoComplete="off"
              className="h-8 w-48 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)] outline-none"
              aria-label={`Value for ${row.name}`}
              placeholder={stored.has(row.name) ? "Replace value" : "Value"}
              value={draft[row.name] ?? ""}
              onChange={(e) => onDraft(row.name, e.target.value)}
            />
            <button
              type="button"
              className="flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 font-sans text-[13px] font-medium text-[var(--sf-text-1)] disabled:opacity-60"
              disabled={!draft[row.name]}
              onClick={() => onSet(row.name)}
            >
              Save
            </button>
            {stored.has(row.name) ? (
              <button
                type="button"
                className="flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 font-sans text-[13px] font-medium text-[var(--sf-fail)]"
                onClick={() => onRemove(row.name)}
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
