import { useState } from "react";
import { LuPlus, LuX } from "react-icons/lu";
import {
  formToConfig,
  parsePastedMcp,
  shouldMaskKey,
  shouldMaskValue,
  type McpFormState,
  type McpKv,
} from "./mcpForm";
import type { ProjectMcpServerConfig } from "../../api";

const INPUT =
  "h-8 w-full rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)] outline-none focus:border-[#ffffff40]";
const BTN =
  "flex h-8 items-center gap-1.5 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 font-sans text-[13px] font-medium text-[var(--sf-text-1)] disabled:opacity-60";
const LABEL = "font-sans text-xs text-[var(--sf-text-3)]";

function KvRows({
  label,
  hint,
  namePlaceholder,
  valuePlaceholder,
  rows,
  onChange,
}: {
  label: string;
  hint: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  rows: McpKv[];
  onChange: (rows: McpKv[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={LABEL}>{label}</span>
      {rows.length > 0 ? (
        <div className="flex gap-1.5">
          <span className={`${LABEL} w-full`}>Name</span>
          <span className={`${LABEL} w-full`}>Value</span>
          <span className="w-8 shrink-0" />
        </div>
      ) : null}
      {rows.map((row, i) => (
        <div key={i} className="flex gap-1.5">
          <input
            type={shouldMaskKey(row.key) ? "password" : "text"}
            autoComplete="off"
            className={INPUT}
            aria-label={`${label} name`}
            placeholder={namePlaceholder}
            value={row.key}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
          />
          <input
            type={shouldMaskValue(row.key, row.value) ? "password" : "text"}
            autoComplete="off"
            className={INPUT}
            aria-label={`${label} value`}
            placeholder={valuePlaceholder}
            value={row.value}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
          />
          <button
            type="button"
            className={BTN}
            aria-label={`Remove ${label} row`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <LuX className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={`${BTN} w-fit`}
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <LuPlus className="size-3.5" aria-hidden /> Add row
      </button>
      <span className={LABEL}>{hint}</span>
    </div>
  );
}

export function McpServerForm({
  initial,
  editing,
  busy,
  error,
  onSave,
  onImport,
  onCancel,
}: {
  initial: McpFormState;
  editing: boolean;
  busy: boolean;
  error: string | null;
  onSave: (name: string, config: ProjectMcpServerConfig) => void;
  onImport: (json: unknown) => void;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<"form" | "paste">(editing ? "form" : "paste");
  const [form, setForm] = useState<McpFormState>(initial);
  const [pasted, setPasted] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const shown = localError ?? error;
  const patch = (next: Partial<McpFormState>) => setForm((f) => ({ ...f, ...next }));

  const submit = () => {
    setLocalError(null);
    if (tab === "paste") {
      const parsed = parsePastedMcp(pasted);
      if (!parsed.ok) return setLocalError(parsed.error);
      return onImport(parsed.value);
    }
    const built = formToConfig(form);
    if (!built.ok) return setLocalError(built.error);
    onSave(built.name, built.config);
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[#ffffff1a] bg-[var(--sf-panel)] p-3.5">
      {!editing ? (
        <div className="flex gap-1.5" role="tablist" aria-label="Add method">
          {(["paste", "form"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`${BTN} ${tab === id ? "border-[#ffffff40]" : "opacity-70"}`}
              onClick={() => setTab(id)}
            >
              {id === "form" ? "Fill in a form" : "Paste JSON"}
            </button>
          ))}
        </div>
      ) : null}

      {tab === "paste" ? (
        <div className="flex flex-col gap-1.5">
          <span className={LABEL}>
            Paste the snippet from the server's docs: local ({"{ \"command\": \"npx\", … }"}) or remote ({"{ \"url\": \"https://…\" }"}),
            with or without the {"\"mcpServers\""} wrapper. Tokens in env or headers are moved to secrets automatically.
          </span>
          <textarea
            className={`${INPUT} h-40 py-2`}
            aria-label="MCP JSON"
            spellCheck={false}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
        </div>
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Name</span>
            <input
              className={INPUT}
              value={form.name}
              disabled={editing}
              placeholder="github"
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Transport">
            {(["stdio", "http"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={form.transport === t}
                className={`${BTN} ${form.transport === t ? "border-[#ffffff40]" : "opacity-70"}`}
                onClick={() => patch({ transport: t })}
              >
                {t === "stdio" ? "Local command (stdio)" : "Remote server (URL)"}
              </button>
            ))}
          </div>
          {form.transport === "stdio" ? (
            <>
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>Command</span>
                <input
                  className={INPUT}
                  value={form.commandLine}
                  placeholder="npx -y @modelcontextprotocol/server-github"
                  onChange={(e) => patch({ commandLine: e.target.value })}
                />
                <span className={LABEL}>The command and its arguments on one line. Use quotes around an argument with spaces.</span>
              </label>
              <KvRows
                label="Environment variables"
                namePlaceholder="GITHUB_PERSONAL_ACCESS_TOKEN"
                valuePlaceholder="paste the token, or ${NAME}"
                hint="Servers that need a key read it from here. A real token typed in is stored as a secret and the file keeps ${NAME}."
                rows={form.env}
                onChange={(env) => patch({ env })}
              />
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>URL</span>
                <input
                  className={INPUT}
                  value={form.url}
                  placeholder="https://example.com/mcp"
                  onChange={(e) => patch({ url: e.target.value })}
                />
              </label>
              <div className="flex flex-col gap-1.5">
                <span className={LABEL}>Connection</span>
                <div className="flex gap-1.5" role="radiogroup" aria-label="Connection type">
                  {(["auto", "sse"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={form.httpTransport === t}
                      className={`${BTN} ${form.httpTransport === t ? "border-[#ffffff40]" : "opacity-70"}`}
                      onClick={() => patch({ httpTransport: t })}
                    >
                      {t === "auto" ? "Automatic (streamable HTTP)" : "SSE only"}
                    </button>
                  ))}
                </div>
                <span className={LABEL}>Automatic tries streamable HTTP and falls back to SSE. Pick SSE only for an older server.</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className={LABEL}>Authorization</span>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Authorization">
                  {(
                    [
                      ["none", "None"],
                      ["bearer", "Bearer token"],
                      ["headers", "Custom headers"],
                    ] as const
                  ).map(([id, text]) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={form.authMode === id}
                      className={`${BTN} ${form.authMode === id ? "border-[#ffffff40]" : "opacity-70"}`}
                      onClick={() => patch({ authMode: id })}
                    >
                      {text}
                    </button>
                  ))}
                </div>
                <span className={LABEL}>
                  Servers that sign you in through your browser (OAuth, like Notion or Linear) need nothing here: leave this
                  on None, then use Sign in on the server after adding it.
                </span>
              </div>
              {form.authMode === "bearer" ? (
                <label className="flex flex-col gap-1.5">
                  <span className={LABEL}>Token</span>
                  <input
                    type="password"
                    autoComplete="off"
                    className={INPUT}
                    value={form.bearerToken}
                    placeholder={form.bearerRef ? `Unchanged — stored as ${form.bearerRef}` : "paste the API key or personal access token"}
                    onChange={(e) => patch({ bearerToken: e.target.value })}
                  />
                  <span className={LABEL}>Sent as Authorization: Bearer … Stored as a secret, never written to the file.</span>
                </label>
              ) : null}
              {form.authMode === "headers" ? (
                <KvRows
                  label="Headers"
                  namePlaceholder="X-Api-Key"
                  valuePlaceholder="paste the value, or ${NAME}"
                  hint="Sent with every request. A real token typed in is stored as a secret and the file keeps ${NAME}."
                  rows={form.headers}
                  onChange={(headers) => patch({ headers })}
                />
              ) : null}
            </>
          )}
        </>
      )}

      {shown ? (
        <p className="font-sans text-[13px] text-[var(--sf-fail)]" role="alert">
          {shown}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="button" className={BTN} disabled={busy} onClick={submit}>
          {busy ? "Saving…" : tab === "paste" ? "Add servers" : editing ? "Save changes" : "Add server"}
        </button>
        <button type="button" className={BTN} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
