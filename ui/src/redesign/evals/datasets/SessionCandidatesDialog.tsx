import { useEffect, useState } from "react";
import { fetchEvalSessionCandidates } from "../../../api/evalsClient";
import type { EvalSessionCandidate } from "../../../api/evalTypes";
import { formatRelativeTime } from "../format";
import { BTN, BTN_PRIMARY, DialogShell, MONO } from "./DialogShell";
import { NO_SESSIONS, addSessionsLabel, sessionMeta, toggleSelection } from "./candidatesModel";

type Props = {
  agentId: string;
  projectRoot?: string;
  subtitle?: string;
  onClose: () => void;
  onConfirm: (sessionIds: string[], items: EvalSessionCandidate[]) => void | Promise<void>;
};

/** Finished, non-eval sessions of an agent. Each becomes a script scenario. */
export function SessionCandidatesDialog({ agentId, projectRoot, subtitle, onClose, onConfirm }: Props) {
  const [items, setItems] = useState<EvalSessionCandidate[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchEvalSessionCandidates(agentId, { limit: 50, ...(projectRoot ? { project_root: projectRoot } : {}) }).then(
      (res) => {
        if (!cancelled) setItems(res.items);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentId, projectRoot]);

  async function confirm() {
    if (!items) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(selected, items.filter((i) => selected.includes(i.session_id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const allSelected = items !== null && items.length > 0 && selected.length === items.length;

  return (
    <DialogShell
      title="Add from past sessions"
      subtitle={subtitle ?? "Finished sessions of this agent. Each becomes a script scenario from its user messages."}
      onClose={onClose}
      footer={
        <>
          <span className="min-w-0 text-xs text-[var(--sf-fail)]" role={error ? "alert" : undefined}>{error}</span>
          <span className="flex shrink-0 items-center gap-2">
            <button type="button" className={BTN} onClick={onClose}>Cancel</button>
            <button type="button" className={BTN_PRIMARY} disabled={busy || selected.length === 0} onClick={() => void confirm()}>
              {addSessionsLabel(selected.length)}
            </button>
          </span>
        </>
      }
    >
      {items === null && !error ? <p className="text-xs text-[var(--sf-text-3)]">Loading sessions…</p> : null}
      {items !== null && items.length === 0 ? <p className="py-6 text-center text-[13px] text-[var(--sf-text-2)]">{NO_SESSIONS}</p> : null}
      {items !== null && items.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-[var(--sf-hairline)]">
          <label className="flex cursor-pointer items-center gap-3 border-b border-b-[var(--sf-hairline)] px-3.5 py-2 text-xs text-[var(--sf-text-3)]">
            <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? [] : items.map((i) => i.session_id))} />
            Select all {items.length}
          </label>
          {items.map((item) => (
            <label key={item.session_id} className="flex cursor-pointer items-start gap-3 border-b border-b-[var(--sf-hairline)] px-3.5 py-2.5 last:border-b-0">
              <input type="checkbox" className="mt-0.5" checked={selected.includes(item.session_id)} onChange={() => setSelected((s) => toggleSelection(s, item.session_id))} />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-[13px] text-[var(--sf-text-1)]" title={item.preview}>{item.preview}</span>
                <span className="text-[11px] text-[var(--sf-text-3)]">
                  {formatRelativeTime(item.updated_at)} · <span className={MONO}>{item.session_id.slice(0, 8)}</span> · {sessionMeta(item)}
                </span>
              </span>
            </label>
          ))}
        </div>
      ) : null}
    </DialogShell>
  );
}
