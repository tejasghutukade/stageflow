import { useEffect, useState } from "react";
import { fetchEvalDatasetCandidates } from "../../../api/evalsClient";
import type { EvalDatasetCandidate, EvalDatasetTarget } from "../../../api/evalTypes";
import { formatRelativeTime } from "../format";
import { BTN, BTN_PRIMARY, DialogShell, MONO } from "./DialogShell";
import { addRunsLabel, toggleSelection } from "./candidatesModel";

export type CandidatesDialogProps = {
  open: boolean;
  title?: string;
  subtitle?: string;
  /** The stage whose past runs are listed. */
  target: EvalDatasetTarget;
  projectRoot?: string;
  /** Label override for the confirm button; defaults to "Add n cases". */
  confirmText?: (count: number) => string;
  onClose: () => void;
  /** Receives the selected run ids and rows. The dialog does not write anything; it stays open until this settles. */
  onConfirm: (runIds: string[], items: EvalDatasetCandidate[]) => void | Promise<void>;
};

export function CandidatesDialog(props: CandidatesDialogProps) {
  if (!props.open) return null;
  return <CandidatesBody {...props} />;
}

function CandidatesBody({
  title = "Add from past runs",
  subtitle,
  target,
  projectRoot,
  confirmText = addRunsLabel,
  onClose,
  onConfirm,
}: CandidatesDialogProps) {
  const [items, setItems] = useState<EvalDatasetCandidate[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const targetKey = JSON.stringify(target);

  useEffect(() => {
    let cancelled = false;
    fetchEvalDatasetCandidates(target, { limit: 50, ...(projectRoot ? { project_root: projectRoot } : {}) }).then(
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, projectRoot]);

  async function confirm() {
    if (!items) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(
        selected,
        items.filter((i) => selected.includes(i.run_id)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const allSelected = items !== null && items.length > 0 && selected.length === items.length;

  return (
    <DialogShell
      title={title}
      subtitle={subtitle ?? "Completed runs of this stage. Each becomes a case with the recorded input."}
      onClose={onClose}
      footer={
        <>
          <span className="min-w-0 text-xs text-[var(--sf-fail)]" role={error ? "alert" : undefined}>{error}</span>
          <span className="flex shrink-0 items-center gap-2">
            <button type="button" className={BTN} onClick={onClose}>Cancel</button>
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={busy || selected.length === 0}
              onClick={() => void confirm()}
            >
              {confirmText(selected.length)}
            </button>
          </span>
        </>
      }
    >
      {items === null && !error ? <p className="text-xs text-[var(--sf-text-3)]">Loading runs…</p> : null}
      {items !== null && items.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-[var(--sf-text-2)]">No past runs of this stage yet.</p>
      ) : null}
      {items !== null && items.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-[var(--sf-hairline)]">
          <label className="flex cursor-pointer items-center gap-3 border-b border-b-[var(--sf-hairline)] px-3.5 py-2 text-xs text-[var(--sf-text-3)]">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? [] : items.map((i) => i.run_id))}
            />
            Select all {items.length}
          </label>
          {items.map((item) => (
            <label
              key={item.run_id}
              className="flex cursor-pointer items-start gap-3 border-b border-b-[var(--sf-hairline)] px-3.5 py-2.5 last:border-b-0"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={selected.includes(item.run_id)}
                onChange={() => setSelected((s) => toggleSelection(s, item.run_id))}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className={`${MONO} truncate text-xs text-[var(--sf-text-1)]`} title={item.preview}>{item.preview}</span>
                <span className="text-[11px] text-[var(--sf-text-3)]">
                  {formatRelativeTime(item.finished_at)} · <span className={MONO}>{item.run_id.slice(0, 8)}</span>
                </span>
              </span>
            </label>
          ))}
        </div>
      ) : null}
    </DialogShell>
  );
}
