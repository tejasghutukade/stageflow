import { useEffect, useState } from "react";
import { LuChevronDown, LuPlus, LuTriangleAlert, LuX } from "react-icons/lu";
import { validateChannelTarget, type ChannelConnectionListing } from "../../api";
import { PROVIDERS } from "../connections/connectionsModel";
import type { StageChannelEntry } from "../workshop/inspector/stageFields";
import {
  channelKey, connectionNote, draftToTemplate, duplicateKeys, emptyChannelEntry, isFilled, parseTo, recipientsText,
  splitList, targetBody, targetSpec, templateToDraft,
} from "./stageChannelsModel";

const LABEL = "w-fit text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[#8b8f98]";
const MONO = "font-['Geist_Mono',monospace]";
const INPUT = `h-[30px] w-full min-w-0 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 text-xs text-[#ecedee] outline-none placeholder:text-[#8b8f98] hover:bg-[#ffffff08] focus:border-[#ecedee73] ${MONO}`;
const SELECT = `h-[30px] w-full min-w-0 appearance-none rounded-lg border border-[#ffffff1a] bg-[#1a1c21] pl-2.5 pr-7 text-xs text-[#ecedee] outline-none hover:bg-[#ffffff08] ${MONO}`;

const providerLabel = (id: string): string => PROVIDERS.find((provider) => provider.id === id)?.label ?? id;

type Validity = { state: "idle" | "checking" | "ok" | "bad" | "unknown" };

function useTargetValidity(entry: StageChannelEntry, known: boolean): Validity {
  const [validity, setValidity] = useState<Validity>({ state: "idle" });
  const key = JSON.stringify([entry.connection, targetBody(entry)]);
  useEffect(() => {
    if (!known || !isFilled(entry)) { setValidity({ state: "idle" }); return; }
    let cancelled = false;
    setValidity({ state: "checking" });
    const timer = window.setTimeout(() => {
      void validateChannelTarget(entry.connection, targetBody(entry)).then(
        (result) => { if (!cancelled) setValidity({ state: result.ok ? "ok" : "bad" }); },
        () => { if (!cancelled) setValidity({ state: "unknown" }); },
      );
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, known]);
  return validity;
}

function ChannelCard({
  entry, connections, duplicate, showName, onChange, onRemove,
}: {
  entry: StageChannelEntry;
  connections: readonly ChannelConnectionListing[];
  duplicate: boolean;
  showName: boolean;
  onChange: (next: StageChannelEntry) => void;
  onRemove: () => void;
}) {
  const connection = connections.find((candidate) => candidate.id === entry.connection);
  const spec = targetSpec(connection?.provider);
  const note = connectionNote(connection, entry.connection);
  const validity = useTargetValidity(entry, Boolean(connection));
  const template = templateToDraft(entry.template);
  const noteColor = note.tone === "ok" ? "text-[#4cc38a]" : note.tone === "warn" ? "text-[#f5b544]" : "text-[#8b8f98]";
  const options = connection || !entry.connection ? connections : [{ id: entry.connection } as ChannelConnectionListing, ...connections];

  const set = (patch: Partial<StageChannelEntry>) => onChange({ ...entry, ...patch });
  const setTemplate = (patch: Partial<typeof template>) => {
    const next = draftToTemplate({ ...template, ...patch });
    const { template: _drop, ...rest } = entry;
    onChange(next ? { ...rest, template: next } : rest);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[#ffffff12] bg-[#16171b] p-2.5" data-testid="stage-channel">
      <div className="flex items-center gap-1.5">
        <div className="relative flex h-[30px] min-w-0 flex-1 items-center">
          <select
            aria-label="connection"
            value={entry.connection}
            onChange={(event) => set({ connection: event.target.value })}
            className={SELECT}
          >
            {!entry.connection ? <option value="">Choose a connection…</option> : null}
            {options.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.displayName ? `${providerLabel(candidate.provider)} · ${candidate.id}` : `${entry.connection} (missing)`}
                {candidate.enabled === false ? " (disabled)" : ""}
              </option>
            ))}
          </select>
          <LuChevronDown className="pointer-events-none absolute right-2.5 size-[13px] text-[#8b8f98]" aria-hidden />
        </div>
        <button type="button" onClick={onRemove} aria-label="Remove channel" className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-[#8b8f98] hover:bg-[#1a1c21] hover:text-[#ecedee]">
          <LuX className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className={`text-[11px] leading-normal ${noteColor}`}>{note.text}</div>

      <div className="flex flex-col gap-1">
        <div className={LABEL}>{spec.toLabel}</div>
        <input
          aria-label={spec.toLabel}
          value={recipientsText(entry.to)}
          placeholder={spec.toPlaceholder}
          spellCheck={false}
          onChange={(event) => set({ to: parseTo(event.target.value, spec.multiple) })}
          className={INPUT}
        />
        {validity.state === "bad" ? (
          <div className="flex items-center gap-1 text-[11px] text-[#f5b544]" role="alert">
            <LuTriangleAlert className="size-3 shrink-0" aria-hidden />
            Not a valid {connection ? providerLabel(connection.provider) : ""} recipient
          </div>
        ) : null}
        {validity.state === "unknown" ? <div className="text-[11px] text-[#8b8f98]">Could not check this recipient</div> : null}
      </div>

      {spec.cc ? (
        <div className="flex flex-col gap-1">
          <div className={LABEL}>Cc (optional)</div>
          <input
            aria-label="Cc"
            value={(entry.cc ?? []).join(", ")}
            spellCheck={false}
            onChange={(event) => {
              const list = splitList(event.target.value);
              const { cc: _drop, ...rest } = entry;
              onChange(list.length ? { ...rest, cc: list } : rest);
            }}
            className={INPUT}
          />
        </div>
      ) : null}

      {spec.template ? (
        <div className="flex flex-col gap-1">
          <div className={LABEL}>Template (needed outside the 24-hour window)</div>
          <div className="flex gap-1.5">
            <input aria-label="Template name" value={template.name} placeholder="order_update" spellCheck={false} onChange={(event) => setTemplate({ name: event.target.value })} className={INPUT} />
            <input aria-label="Template language" value={template.languageCode} placeholder="en_US" spellCheck={false} onChange={(event) => setTemplate({ languageCode: event.target.value })} className={`${INPUT} max-w-[84px]`} />
          </div>
          <input aria-label="Template parameters" value={template.bodyParams} placeholder="{{message}}" spellCheck={false} onChange={(event) => setTemplate({ bodyParams: event.target.value })} className={INPUT} />
        </div>
      ) : null}

      {showName ? (
      <div className="flex flex-col gap-1">
        <div className={LABEL}>Name {duplicate ? "(must be unique)" : "(optional)"}</div>
        <input
          aria-label="Channel name"
          value={entry.alias ?? ""}
          placeholder={entry.connection || "connection id"}
          spellCheck={false}
          onChange={(event) => {
            const { alias: _drop, ...rest } = entry;
            const value = event.target.value.trim();
            onChange(value ? { ...rest, alias: value } : rest);
          }}
          className={`${INPUT} ${duplicate ? "border-[#f5b544]" : ""}`}
        />
        <div className="text-[11px] leading-[1.4] text-[#8b8f98]">The agent calls send_message with this name: {channelKey(entry) || "…"}</div>
      </div>
      ) : null}
    </div>
  );
}

export function StageChannelsSection({
  entries, connections, loadFailed, limit = 1, onChange,
}: {
  entries: readonly StageChannelEntry[];
  connections: readonly ChannelConnectionListing[];
  loadFailed: boolean;
  /** How many channels one stage may use. The host decides and enforces it; the form only follows. */
  limit?: number;
  onChange: (next: StageChannelEntry[]) => void;
}) {
  const duplicates = new Set(duplicateKeys(entries));
  const atLimit = entries.length >= limit;
  const overLimit = entries.length > limit;
  return (
    <div className="flex flex-col gap-1.5" data-testid="stage-channels">
      <div className="flex items-center">
        <div className={`${LABEL} flex-1`}>channels</div>
        <div className="text-[11px] leading-normal text-[#8b8f98]">send only</div>
      </div>
      {loadFailed ? <div className="text-[11px] text-[#f5b544]">Could not load connections</div> : null}
      {entries.length === 0 ? (
        <div className="text-[11px] leading-[1.45] text-[#8b8f98]">
          No channels. This stage cannot send messages{connections.length === 0 ? ", and no connections exist yet" : ""}.
        </div>
      ) : null}
      {entries.map((entry, index) => (
        <ChannelCard
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          entry={entry}
          connections={connections}
          duplicate={duplicates.has(channelKey(entry))}
          showName={limit > 1}
          onChange={(next) => onChange(entries.map((current, at) => (at === index ? next : current)))}
          onRemove={() => onChange(entries.filter((_, at) => at !== index))}
        />
      ))}
      {overLimit ? (
        <div className="flex items-start gap-1 text-[11px] leading-[1.4] text-[#f5b544]" role="alert">
          <LuTriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          This stage lists {entries.length} channels but can use {limit}. Remove the extra ones or the run will not start.
        </div>
      ) : null}
      {atLimit ? (
        <div className="text-[11px] leading-[1.45] text-[#8b8f98]" data-testid="channel-limit-note">
          {limit === 1 ? "A stage can use one channel for now." : `A stage can use up to ${limit} channels.`} To use another, split the work into a separate stage.
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onChange([...entries, emptyChannelEntry(connections)])}
          disabled={connections.length === 0}
          className="flex h-7 w-fit items-center gap-1.5 rounded-md border border-[#ffffff1a] px-2 text-xs text-[#a7aab2] hover:bg-[#1a1c21] disabled:opacity-50"
          title={connections.length === 0 ? "Connect a provider on the Connections page first" : undefined}
        >
          <LuPlus className="size-3" aria-hidden />
          Add channel
        </button>
      )}
    </div>
  );
}
