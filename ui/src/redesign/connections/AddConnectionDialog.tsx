import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LuCheck, LuCopy, LuKeyRound, LuTriangleAlert, LuX } from "react-icons/lu";
import {
  ChannelApiError, createChannelConnection, testChannelConnection,
  type ChannelConnectionListing, type ChannelHealth, type ChannelMeta, type ChannelProviderField,
} from "../../api";
import { errorReason, useChannelMeta } from "./channelMeta";
import { apiErrorMessage, buildNewConnection, fixHint, missingFields, type FormValues } from "./connectionsModel";
import { providerIcon } from "./providerIcons";

const MONO = "[font-family:'Geist_Mono',_monospace]";
const NOWRAP = "[white-space-collapse:collapse] [text-wrap-mode:nowrap]";
const EYEBROW = `text-[#8b8f98] font-sans text-[11px] font-medium leading-normal tracking-[0.88px] uppercase ${NOWRAP}`;
const INPUT = "h-9 w-full rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 text-[13px] text-[#ecedee] outline-none placeholder:text-[#8b8f98] focus:border-[#ecedee73]";

function ViaTag({ via }: { via: string }) {
  return <span className={`rounded-[4px] border border-[#ffffff1a] bg-[#1a1c21] px-1.5 text-[11px] leading-[18px] text-[#a7aab2] ${NOWRAP}`}>via {via}</span>;
}

function FieldInput({ field, value, onChange }: { field: ChannelProviderField; value: string; onChange: (value: string) => void }) {
  const id = `connection-field-${field.key}`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium leading-normal text-[#ecedee]">{field.label}</label>
      {field.input === "select" ? (
        <select id={id} value={value || field.defaultValue || ""} onChange={(event) => onChange(event.target.value)} className={INPUT}>
          {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : (
        <div className="relative">
          {field.input === "password" ? <LuKeyRound className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[#8b8f98]" aria-hidden /> : null}
          <input
            id={id}
            type={field.input === "password" ? "password" : "text"}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.placeholder}
            autoComplete="off"
            spellCheck={false}
            className={`${INPUT} ${field.input === "password" ? `pl-9 ${MONO}` : ""}`}
          />
        </div>
      )}
      {field.hint ? <span className="text-xs leading-[1.4] text-[#8b8f98]">{field.hint}</span> : null}
    </div>
  );
}

export function ResultLine({ health, meta }: { health: ChannelHealth; meta: ChannelMeta | null }) {
  if (health.state === "ok") {
    return (
      <div className="flex items-center gap-2 text-[13px] text-[#4cc38a]" role="status">
        <LuCheck className="size-3.5 block" aria-hidden />
        The provider accepted the credentials.
      </div>
    );
  }
  const code = health.error?.code;
  const hint = fixHint(code, meta);
  return (
    <div className="flex items-start gap-2 text-[13px] text-[#f5b544]" role="alert">
      <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="flex flex-col gap-0.5">
        <span>{code ? errorReason(meta, code) : "The check failed."}</span>
        {hint ? <span className="text-xs text-[#a7aab2]">{hint}</span> : null}
      </div>
    </div>
  );
}

export function AddConnectionDialog({
  initial, existing, onClose, onSaved,
}: {
  initial: string;
  existing: readonly ChannelConnectionListing[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { meta, failed: metaFailed } = useChannelMeta();
  const [selected, setSelected] = useState<string>(initial);
  const [values, setValues] = useState<FormValues>({});
  const [useSaved, setUseSaved] = useState(true);
  const [result, setResult] = useState<ChannelHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [showYaml, setShowYaml] = useState(false);
  const [copied, setCopied] = useState(false);

  const providers = meta?.providers ?? [];
  const provider = providers.find((entry) => entry.id === selected) ?? providers[0];
  const savedCredential = provider?.fields.some((field) => field.target === "credential")
    ? existing.find((entry) => entry.credential)?.credential
    : undefined;
  const reuse = Boolean(savedCredential) && useSaved;
  const missing = provider ? missingFields(provider, values, reuse) : [];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const select = (id: string) => { setSelected(id); setValues({}); setResult(null); setError(null); };
  const payload = () => buildNewConnection(provider!, values, reuse && savedCredential ? { savedCredential } : {});

  const run = async (kind: "test" | "save") => {
    if (!provider) return;
    if (missing.length > 0) { setError("Fill in the required fields first."); return; }
    setBusy(kind);
    setError(null);
    try {
      if (kind === "test") {
        setResult(await testChannelConnection(payload()));
      } else {
        const saved = await createChannelConnection(payload());
        onSaved(saved.id);
      }
    } catch (caught) {
      setError(apiErrorMessage(caught instanceof ChannelApiError ? caught.code : "unknown", meta));
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#040506a8] p-4" role="presentation" onClick={() => { if (!busy) onClose(); }}>
      <form
        className="flex max-h-[90vh] w-full max-w-[600px] flex-col overflow-y-auto rounded-xl border border-[#ffffff1a] bg-[#131418] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
        role="dialog" aria-modal="true" aria-labelledby="add-connection-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); void run("save"); }}
      >
        <div className="flex items-start gap-3 border-b border-b-[#ffffff12] px-5 py-4">
          <div className="flex flex-1 flex-col gap-1">
            <h2 id="add-connection-title" className="text-lg font-semibold tracking-[-0.36px] text-[#ecedee]">Connect {provider?.label ?? "a provider"}</h2>
            <p className="text-[13px] leading-normal text-[#a7aab2]">Secrets are stored on this host and never written to connections.yaml.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex size-7 items-center justify-center rounded-md text-[#8b8f98] hover:bg-[#1a1c21]">
            <LuX className="size-4 block" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Provider">
            {providers.map((entry) => {
              const Icon = providerIcon(entry.icon);
              return (
                <button
                  key={entry.id} type="button" role="tab" aria-selected={entry.id === selected} onClick={() => select(entry.id)}
                  className={`flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[13px] ${entry.id === selected ? "border-[#6ca6ff] bg-[#1a1c21] text-[#ecedee]" : "border-[#ffffff1a] text-[#a7aab2] hover:bg-[#1a1c21]"}`}
                >
                  <Icon className="size-3.5 block text-[#a7aab2]" aria-hidden />
                  {entry.label}
                  {entry.via ? <ViaTag via={entry.via} /> : null}
                </button>
              );
            })}
          </div>

          {savedCredential ? (
            <label className="flex items-center gap-2 text-[13px] text-[#a7aab2]">
              <input type="checkbox" checked={useSaved} onChange={(event) => setUseSaved(event.target.checked)} />
              Use the Photon project already saved (<span className={MONO}>{savedCredential}</span>)
            </label>
          ) : null}

          {!provider ? (
            <p className="text-[13px] text-[#8b8f98]" role={metaFailed ? "alert" : undefined}>
              {metaFailed ? "Could not load provider details from the host." : "Loading providers…"}
            </p>
          ) : null}
          {provider?.fields.filter((field) => !(reuse && field.target === "credential")).map((field) => (
            <FieldInput key={field.key} field={field} value={values[field.key] ?? ""} onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} />
          ))}
          {provider?.note ? <p className="text-xs leading-[1.5] text-[#8b8f98]">{provider.note}</p> : null}

          {result ? <ResultLine health={result} meta={meta} /> : null}
          {error ? (
            <div className="flex items-start gap-2 text-[13px] text-[#f2645a]" role="alert">
              <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {error}
            </div>
          ) : null}

          <div className="flex flex-col gap-2 border-t border-t-[#ffffff12] pt-3">
            <button type="button" onClick={() => setShowYaml((open) => !open)} className="w-fit text-xs text-[#8b8f98] underline hover:text-[#ecedee]" aria-expanded={showYaml}>
              {showYaml ? "Hide" : "Prefer to edit connections.yaml yourself?"}
            </button>
            {showYaml && provider ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className={EYEBROW}>connections.yaml</span>
                  <button
                    type="button"
                    onClick={() => { void navigator.clipboard?.writeText(provider?.yamlExample ?? "").then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }, () => undefined); }}
                    className="flex h-7 items-center gap-1.5 rounded-md border border-[#ffffff1a] px-2 text-xs text-[#a7aab2] hover:bg-[#1a1c21]"
                  >
                    {copied ? <LuCheck className="size-3 block text-[#4cc38a]" aria-hidden /> : <LuCopy className="size-3 block" aria-hidden />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className={`overflow-x-auto rounded-lg border border-[#ffffff12] bg-[#0c0d0f] p-3 text-xs leading-[1.6] text-[#ecedee] ${MONO}`}>{provider?.yamlExample}</pre>
                <p className="text-xs leading-[1.5] text-[#8b8f98]">Set {provider?.envNames.join(", ")} on the host, then restart. Values written as <span className={MONO}>env:NAME</span> are read from the host environment.</p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-t-[#ffffff12] px-5 py-3">
          <button
            type="button" onClick={() => void run("test")} disabled={busy !== null || !provider}
            className="flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 text-[13px] font-medium text-[#ecedee] disabled:opacity-60"
          >
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={busy === "save"} className="flex h-8 items-center rounded-lg px-3 text-[13px] text-[#a7aab2] hover:bg-[#1a1c21]">Cancel</button>
            <button
              type="submit" disabled={busy !== null || !provider}
              className="flex h-8 items-center rounded-lg bg-[#ecedee] px-3 text-[13px] font-medium text-[#0c0d0f] disabled:opacity-60"
            >
              {busy === "save" ? "Connecting…" : `Connect ${provider?.label ?? ""}`}
            </button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  );
}
