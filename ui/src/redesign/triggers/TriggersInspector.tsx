import { useCallback, useEffect, useState } from "react";
import {
  fetchTrigger,
  fireTrigger,
  patchTrigger,
  type TriggerListItem,
} from "../../api";
import type { CatalogSnapshot } from "../../catalog/source";
import { relativeTime } from "../../catalogJoin";
import { runStreamPath } from "../../routes";
import { showToast } from "../../toast";
import { runDisplayStatus } from "../../status/runStatus";
import { Inspector } from "../shell/Inspector";
import { StatusPill } from "../StatusPill";
import { runStatusPillLabel, statusSignalFromRun } from "../statusSignal";
import {
  triggerScheduleSummary,
  triggerTaskLabel,
} from "../../pages/TriggersPage";
import { adapterStatusLabel } from "./triggerAdapterLabel";
import { nextScheduleRuns } from "./cronPreview";
import { scheduleWithoutCatalogTask } from "./triggerViews";

export function TriggersInspector({
  triggerId,
  snapshot,
  onRefreshList,
}: {
  triggerId: string;
  snapshot: CatalogSnapshot;
  onRefreshList: () => void;
}) {
  const [trigger, setTrigger] = useState<TriggerListItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [firing, setFiring] = useState(false);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = await fetchTrigger(triggerId);
      setTrigger(t);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTrigger(null);
    } finally {
      setLoading(false);
    }
  }, [triggerId]);

  useEffect(() => {
    setLoading(true);
    setTrigger(null);
    void load();
  }, [load]);

  async function onFire() {
    setFiring(true);
    try {
      const result = await fireTrigger(triggerId);
      showToast(
        result.queued
          ? `Trigger queued · ${triggerId}`
          : `Trigger fired · ${triggerId} · ${result.runId}`,
      );
      await load();
      onRefreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFiring(false);
    }
  }

  async function onToggleEnabled() {
    if (!trigger) return;
    setToggling(true);
    try {
      const updated = await patchTrigger(triggerId, {
        enabled: !trigger.enabled,
      });
      setTrigger(updated);
      onRefreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  }

  const lastRun = trigger?.last_run_id
    ? snapshot.runs.find((r) => r.run_id === trigger.last_run_id)
    : undefined;

  const previewRuns =
    trigger?.kind === "schedule" && trigger.schedule
      ? nextScheduleRuns(trigger.schedule, new Date(), 3)
      : [];

  return (
    <Inspector className="!w-[420px]">
      <div className="mb-3 flex flex-col gap-1 border-b border-b-[#ffffff12] pb-2.5">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Trigger
          </span>
          <label className="flex items-center gap-1.5 pl-1 text-xs text-[var(--sf-text-2)]">
            Enabled
            <button
              type="button"
              disabled={toggling || !trigger}
              className={`flex h-4 w-7 items-center rounded-full p-0.5 disabled:opacity-50 ${
                trigger?.enabled
                  ? "justify-end bg-[var(--sf-text-1)]"
                  : "justify-start bg-[var(--sf-track-empty)]"
              }`}
              onClick={() => void onToggleEnabled()}
              aria-pressed={trigger?.enabled ?? false}
            >
              <span className="size-3 rounded-full bg-[var(--sf-ground)]" />
            </button>
          </label>
        </div>
        <h2 className="font-['Geist_Mono',monospace] text-[15px] font-semibold text-[var(--sf-text-1)]">
          {triggerId}
        </h2>
        {trigger?.definition_ref ? (
          <p className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
            {trigger.definition_ref}
          </p>
        ) : loading ? (
          <p className="text-[12px] text-[var(--sf-text-3)]">Loading…</p>
        ) : null}
      </div>

      {error ? <p className="mb-3 text-[12px] text-[var(--sf-fail)]">{error}</p> : null}
      {!loading && !trigger ? (
        <p className="text-[13px] text-[var(--sf-text-3)]">
          Trigger not found in catalog.
        </p>
      ) : null}
      {trigger ? (
        <>
          {scheduleWithoutCatalogTask(trigger) ? (
            <div className="mb-3 rounded-lg border border-[color-mix(in_srgb,var(--sf-needs)_40%,transparent)] bg-[color-mix(in_srgb,var(--sf-needs)_12%,transparent)] px-2.5 py-2 text-[12px] text-[var(--sf-text-2)]">
              Schedule triggers need a catalog task to fire automatically.
              Dynamic tasks must be fired by hand.
            </div>
          ) : null}
          <dl className="m-0 space-y-2 text-[12px]">
            <div>
              <dt className="text-[var(--sf-text-3)]">Pipeline</dt>
              <dd className="mt-0.5 font-['Geist_Mono',monospace] text-[var(--sf-text-1)]">
                {trigger.pipeline}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--sf-text-3)]">Task</dt>
              <dd
                className={`mt-0.5 ${trigger.task ? "font-['Geist_Mono',monospace] text-[var(--sf-text-1)]" : "text-[var(--sf-text-3)]"}`}
              >
                {triggerTaskLabel(trigger.task)}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--sf-text-3)]">Schedule / event</dt>
              <dd className="mt-0.5 font-['Geist_Mono',monospace] text-[var(--sf-text-1)]">
                {triggerScheduleSummary(trigger)}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--sf-text-3)]">Adapter</dt>
              <dd className="mt-0.5 text-[var(--sf-text-1)]">
                {adapterStatusLabel(trigger, trigger.adapter_status)}
              </dd>
            </div>
            {trigger.next_run_at ? (
              <div>
                <dt className="text-[var(--sf-text-3)]">Next run</dt>
                <dd className="mt-0.5 text-[var(--sf-text-1)]">
                  {relativeTime(trigger.next_run_at)}
                  <div className="font-['Geist_Mono',monospace] text-[var(--sf-text-3)]">
                    {trigger.next_run_at}
                  </div>
                </dd>
              </div>
            ) : null}
            {previewRuns.length > 0 ? (
              <div>
                <dt className="text-[var(--sf-text-3)]">Preview</dt>
                <dd className="mt-0.5">
                  <ul className="m-0 list-none space-y-1 p-0 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
                    {previewRuns.map((d) => (
                      <li key={d.toISOString()}>{d.toISOString()}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-[var(--sf-text-3)]">Last fired</dt>
              <dd className="mt-0.5 text-[var(--sf-text-1)]">
                {trigger.last_fired_at
                  ? relativeTime(trigger.last_fired_at)
                  : "never"}
              </dd>
            </div>
            {lastRun ? (
              <div>
                <dt className="text-[var(--sf-text-3)]">Last run</dt>
                <dd className="mt-0.5 flex flex-wrap items-center gap-2">
                  <a
                    className="font-['Geist_Mono',monospace] text-[var(--sf-running)]"
                    href={`#${runStreamPath(lastRun.run_id)}`}
                  >
                    {lastRun.run_id}
                  </a>
                  <StatusPill
                    signal={statusSignalFromRun(lastRun)}
                    label={runStatusPillLabel(runDisplayStatus(lastRun))}
                  />
                </dd>
              </div>
            ) : null}
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="sf-btn sf-btn--primary"
              disabled={firing || !trigger.enabled}
              onClick={() => void onFire()}
            >
              {firing ? "Firing…" : "Fire"}
            </button>
          </div>
        </>
      ) : null}
    </Inspector>
  );
}
