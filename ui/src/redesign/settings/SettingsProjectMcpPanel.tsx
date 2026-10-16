import { useEffect, useRef, useState } from "react";
import { LuPlus } from "react-icons/lu";
import type { McpSecretsList, ProjectMcpServerConfig } from "../../api";
import { McpServerForm } from "./McpServerForm";
import { McpSignIn } from "./McpSignIn";
import { projectMcpApi, type ProjectMcpApi } from "./mcpApi";
import {
  canSignIn,
  configToForm,
  emptyMcpForm,
  isSignedIn,
  secretRowDetail,
  secretRows,
  type McpFormState,
} from "./mcpForm";
import {
  PROJECT_MCP_SETTINGS_COPY,
  createProjectMcpSettingsSession,
  projectMcpDotColor,
  projectMcpSectionError,
  projectMcpStatusLabel,
  type ProjectMcpOutcome,
  type ProjectMcpSession,
  type ProjectMcpSettingsState,
} from "./mcpSession";
import { SettingsEyebrow } from "./SettingsSectionPanels";

export function SettingsProjectMcpPanel({ api = projectMcpApi }: { api?: ProjectMcpApi } = {}) {
  const sessionRef = useRef<ProjectMcpSession | null>(null);
  const [state, setState] = useState<ProjectMcpSettingsState>(() => createProjectMcpSettingsSession(api).getState());
  const [form, setForm] = useState<{ initial: McpFormState; editing: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const session = createProjectMcpSettingsSession(api);
    sessionRef.current = session;
    setState(session.getState());
    const unsubscribe = session.subscribe(() => setState(session.getState()));
    // Show real status on arrival instead of waiting for a click on Check.
    void session.load().then(() => session.checkAll());
    return () => {
      unsubscribe();
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [api]);

  const session = () => sessionRef.current;
  const fail = (err: unknown) => setFormError(err instanceof Error ? err.message : String(err));
  /** Every failure shows the same way; successes may carry a notice. */
  const settle = (outcome: ProjectMcpOutcome | undefined): boolean => {
    if (!outcome) return false;
    if (!outcome.ok) {
      setFormError(outcome.error);
      return false;
    }
    if (outcome.notice !== null) setNotice(outcome.notice);
    return true;
  };

  const openAdd = () => {
    setFormError(null);
    setNotice(null);
    setForm({ initial: emptyMcpForm(), editing: false });
  };
  const openEdit = async (name: string) => {
    setFormError(null);
    setNotice(null);
    try {
      const { config } = await api.getServer(name);
      setForm({ initial: configToForm(name, config), editing: true });
    } catch (err) {
      fail(err);
    }
  };
  const onSave = async (name: string, config: ProjectMcpServerConfig) => {
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      if (settle(await session()?.save(name, config))) setForm(null);
    } finally {
      setBusy(false);
    }
  };
  const onImport = async (json: unknown) => {
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      if (settle(await session()?.importJson(json))) setForm(null);
    } finally {
      setBusy(false);
    }
  };
  const onDelete = async (name: string) => {
    if (!window.confirm(`Remove ${name}? Agents or stages that use it will stop working.`)) return;
    setFormError(null);
    setNotice(null);
    settle(await session()?.remove(name));
  };
  const onSignedIn = async (name: string) => settle(await session()?.signedIn(name));
  const onSignOut = async (name: string) => {
    if (!window.confirm(`Sign out of ${name}? Agents lose access until you sign in again.`)) return;
    setFormError(null);
    settle(await session()?.signOut(name));
  };
  const onSetSecret = async (name: string) => {
    setFormError(null);
    settle(await session()?.saveSecret(name));
  };
  const onRemoveSecret = async (name: string) => {
    if (!window.confirm(`Remove the stored value for ${name}?`)) return;
    setFormError(null);
    settle(await session()?.removeSecret(name));
  };

  const { oauth, secrets, signingIn, secretDrafts } = state;

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
            const dot = projectMcpDotColor(row.status);
            const probing = row.status === "probing";
            const last = index === state.servers.length - 1;
            const signedIn = isSignedIn(oauth[row.name]);
            const offerSignIn = canSignIn(row, oauth[row.name]);
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
                    {dot ? <span className="size-1.5 rounded-full" style={{ backgroundColor: dot }} /> : null}
                    {projectMcpStatusLabel(row.status)}
                  </span>
                  {signedIn ? (
                    <span className="font-sans text-xs text-[var(--sf-text-3)]">signed in</span>
                  ) : null}
                  {offerSignIn ? (
                    <button
                      type="button"
                      className="flex h-8 items-center rounded-lg border border-[#ffffff40] bg-[var(--sf-raised)] px-3 py-0 font-sans text-[13px] font-medium text-[var(--sf-text-1)]"
                      onClick={() => session()?.startSignIn(row.name)}
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
                    onClick={() => void session()?.check(row.name)}
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
                  api={api}
                  onDone={() => void onSignedIn(row.name)}
                  onCancel={() => session()?.cancelSignIn()}
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
          draft={secretDrafts}
          onDraft={(name, value) => session()?.setDraft(name, value)}
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
  const rows = secretRows(secrets);
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
                {secretRowDetail(row)}
              </span>
            </span>
            <input
              type="password"
              autoComplete="off"
              className="h-8 w-48 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)] outline-none"
              aria-label={`Value for ${row.name}`}
              placeholder={row.stored ? "Replace value" : "Value"}
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
            {row.stored ? (
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
