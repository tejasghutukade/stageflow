import { useState } from "react";
import { LuUsers } from "react-icons/lu";
import type { A2aCaller, A2aPublication } from "../../api/a2a";
import { CARD, DANGER, EYEBROW, EmptyState, Field, GHOST, INPUT, MONO, PRIMARY, SECONDARY, Tag } from "../identity/identityParts";
import { callerNameProblem, callerUsage } from "./a2aView";

const GRID = "grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_168px_200px] items-center gap-4";

export function CallersPanel({
  callers,
  publications,
  busy,
  onAdd,
  onAllowRunStage,
  onRevoke,
}: {
  callers: readonly A2aCaller[];
  publications: readonly A2aPublication[];
  busy: boolean;
  onAdd: (name: string, allowRunStage: boolean) => void;
  onAllowRunStage: (id: string, allowRunStage: boolean) => void;
  onRevoke: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [allowRunStage, setAllowRunStage] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const trimmed = name.trim();
  const problem = callerNameProblem(trimmed, callers.map((row) => row.id));
  const ready = trimmed.length > 0 && problem === null;

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col items-start gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          onAdd(trimmed, allowRunStage);
          setName("");
          setAllowRunStage(false);
        }}
      >
        <div className="flex items-end gap-3">
          <Field label="Caller name" hint="The outside agent that will call, for example procurement-assistant." error={problem} className="w-full max-w-[360px]">
            <input
              className={`${INPUT} ${MONO}`}
              value={name}
              placeholder="procurement-assistant"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <button type="submit" className={PRIMARY} disabled={busy || !ready}>Add caller</button>
        </div>
        <label className="flex items-start gap-2 text-[13px] text-[#ecedee]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={allowRunStage}
            disabled={busy}
            aria-label="Allow run_stage"
            onChange={(event) => setAllowRunStage(event.target.checked)}
          />
          <span className="flex flex-col gap-0.5">
            <span>Allow run_stage</span>
            <span className="text-xs text-[#8b8f98]">Stays off until you set it. An opted-in caller has shell on the Host and can read any run&apos;s envelopes.</span>
          </span>
        </label>
      </form>

      {callers.length === 0 ? (
        <EmptyState icon={<LuUsers className="block size-4 text-[#a7aab2]" aria-hidden />} title="No callers yet">
          <p>A caller is an outside agent. Add one to get its token, then let it use a published pipeline.</p>
        </EmptyState>
      ) : (
        <div className={`${CARD} overflow-hidden`}>
          <div className={`${GRID} px-4 py-2.5`}>
            <span className={EYEBROW}>Caller</span>
            <span className={EYEBROW}>May call</span>
            <span className={EYEBROW}>Allow run_stage</span>
            <span />
          </div>
          {callers.map((row) => {
            const used = callerUsage(row.id, publications);
            return (
              <div key={row.id} className={`${GRID} border-t border-t-[#ffffff12] px-4 py-3`}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`truncate text-[13px] font-medium text-[#ecedee] ${MONO}`}>{row.id}</span>
                  {row.tokenSource === "env" ? <Tag>Token from environment</Tag> : null}
                </div>
                <span className={`truncate text-xs ${used.length > 0 ? `text-[#ecedee] ${MONO}` : "text-[#8b8f98]"}`}>
                  {used.length > 0 ? used.join(", ") : "No published pipeline"}
                </span>
                <label className="flex items-center gap-2 text-xs text-[#ecedee]">
                  <input
                    type="checkbox"
                    checked={row.allowRunStage}
                    disabled={busy}
                    aria-label={`Allow run_stage for ${row.id}`}
                    onChange={(event) => onAllowRunStage(row.id, event.target.checked)}
                  />
                  <span className="text-[#8b8f98]">{row.allowRunStage ? "On" : "Off"}</span>
                </label>
                <div className="flex items-center justify-end gap-2">
                  {confirming === row.id ? (
                    <>
                      <button type="button" className={DANGER} disabled={busy} onClick={() => { setConfirming(null); onRevoke(row.id); }}>Revoke</button>
                      <button type="button" className={GHOST} onClick={() => setConfirming(null)}>Keep</button>
                    </>
                  ) : (
                    <button type="button" className={SECONDARY} disabled={busy} onClick={() => setConfirming(row.id)}>Revoke…</button>
                  )}
                </div>
              </div>
            );
          })}
          <p className="border-t border-t-[#ffffff12] px-4 py-3 text-xs text-[#8b8f98]">
            Revoking removes the caller from every published pipeline. Its token stops working on its next request.
          </p>
        </div>
      )}
    </div>
  );
}
