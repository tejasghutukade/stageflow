import { useCallback, useEffect, useState } from "react";
import {
  fetchTrigger,
  fetchTriggers,
  fireTrigger,
  type TriggerListItem,
} from "../api";
import { relativeTime } from "../catalogJoin";
import { NewTriggerPanel } from "../components/NewTriggerPanel";
import { runStreamPath, triggerPath } from "../routes";
import { showToast } from "../toast";

export function triggerKindLabel(kind: TriggerListItem["kind"]): string {
  if (kind === "schedule") return "Schedule";
  if (kind === "event") return "Event";
  return "Manual";
}

export function triggerScheduleSummary(
  trigger: Pick<TriggerListItem, "kind" | "schedule" | "event">,
): string {
  if (trigger.kind === "schedule" && trigger.schedule) {
    return trigger.schedule.timezone
      ? `${trigger.schedule.cron} (${trigger.schedule.timezone})`
      : trigger.schedule.cron;
  }
  if (trigger.kind === "event" && trigger.event) {
    return `on ${trigger.event.source}`;
  }
  return "Fired manually only";
}

export function triggerEnabledLabel(enabled: boolean): string {
  return enabled ? "Enabled" : "Disabled";
}

export function triggerTaskLabel(task?: string): string {
  return task ?? "Dynamic (task supplied at fire time)";
}

export function triggerTaskSummary(task?: string): string {
  return task ?? "Dynamic";
}

export function TriggersPage({
  triggerId,
}: {
  triggerId?: string;
}) {
  const [triggers, setTriggers] = useState<TriggerListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newTriggerPanelOpen, setNewTriggerPanelOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = await fetchTriggers();
      setTriggers(t.triggers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onTriggerCreated(trigger: TriggerListItem) {
    setNewTriggerPanelOpen(false);
    await load();
    showToast(`Trigger created · ${trigger.id}`);
  }

  if (triggerId) {
    return <TriggerDetail triggerId={triggerId} onRefreshList={load} />;
  }

  return (
    <div className="main__inner main__inner--wide">
      <div className="page-head">
        <div>
          <h1>Triggers</h1>
          <p>
            Manifest-declared triggers and what they fire. Schedule and event
            triggers run automatically; every trigger can also be fired by
            hand.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setNewTriggerPanelOpen(true)}
        >
          New trigger
        </button>
      </div>

      {error ? (
        <p style={{ color: "var(--color-text-red)" }}>{error}</p>
      ) : null}
      {loading ? <p className="muted">Loading triggers…</p> : null}
      {!loading && triggers.length === 0 ? (
        <div className="empty-hint">
          <p style={{ margin: "0 0 var(--spacing-3)" }}>
            No triggers yet. Add a <span className="mono">*.trigger.yaml</span>{" "}
            file to this project's catalog.
          </p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setNewTriggerPanelOpen(true)}
          >
            New trigger
          </button>
        </div>
      ) : null}

      {!loading && triggers.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Trigger</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Last fired</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {triggers.map((trigger) => (
              <tr key={trigger.id}>
                <td>
                  <a href={`#${triggerPath(trigger.id)}`}>{trigger.id}</a>
                  <div
                    className="muted"
                    style={{ fontSize: "var(--font-size-xs)" }}
                  >
                    {trigger.pipeline} · {triggerTaskSummary(trigger.task)}
                  </div>
                </td>
                <td className="mono">{triggerKindLabel(trigger.kind)}</td>
                <td>
                  <span className={trigger.enabled ? undefined : "muted"}>
                    {triggerEnabledLabel(trigger.enabled)}
                  </span>
                </td>
                <td className="muted">
                  {trigger.last_fired_at
                    ? relativeTime(trigger.last_fired_at)
                    : "never"}
                </td>
                <td style={{ textAlign: "right" }}>
                  <a
                    className="btn btn--sm"
                    href={`#${triggerPath(trigger.id)}`}
                  >
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <NewTriggerPanel
        isOpen={newTriggerPanelOpen}
        onClose={() => setNewTriggerPanelOpen(false)}
        onCreated={(trigger) => void onTriggerCreated(trigger)}
      />
    </div>
  );
}

function TriggerDetail({
  triggerId,
  onRefreshList,
}: {
  triggerId: string;
  onRefreshList: () => void;
}) {
  const [trigger, setTrigger] = useState<TriggerListItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [firing, setFiring] = useState(false);

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

  const subtitle = trigger
    ? `${trigger.definition_ref} · ${triggerKindLabel(trigger.kind)}`
    : triggerId;

  return (
    <div className="main__inner">
      <p className="crumbs">
        <a href="#/triggers">Triggers</a> / {triggerId}
      </p>

      <div className="page-head">
        <div>
          <h1>{triggerId}</h1>
          <p className="mono">{subtitle}</p>
        </div>
        {trigger ? (
          <button
            className="btn btn--primary"
            disabled={firing}
            onClick={() => void onFire()}
          >
            {firing ? "Firing…" : "Fire"}
          </button>
        ) : null}
      </div>

      {error ? (
        <p style={{ color: "var(--color-text-red)" }}>{error}</p>
      ) : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {!loading && !trigger ? (
        <p className="muted">
          {triggerId} is not in the current manifest catalog.
        </p>
      ) : null}

      {trigger ? (
        <dl className="kv">
          <dt>Pipeline</dt>
          <dd>{trigger.pipeline}</dd>
          <dt>Task</dt>
          <dd className={trigger.task ? undefined : "muted"}>
            {triggerTaskLabel(trigger.task)}
          </dd>
          <dt>Kind</dt>
          <dd>{triggerKindLabel(trigger.kind)}</dd>
          <dt>Schedule</dt>
          <dd>{triggerScheduleSummary(trigger)}</dd>
          <dt>Status</dt>
          <dd>{triggerEnabledLabel(trigger.enabled)}</dd>
          <dt>Last fired</dt>
          <dd>
            {trigger.last_fired_at
              ? relativeTime(trigger.last_fired_at)
              : "never"}
          </dd>
          {trigger.last_run_id ? (
            <>
              <dt>Last run</dt>
              <dd>
                <a href={`#${runStreamPath(trigger.last_run_id)}`}>
                  {trigger.last_run_id}
                </a>
              </dd>
            </>
          ) : null}
          {trigger.next_run_at ? (
            <>
              <dt>Next run</dt>
              <dd className="mono">{trigger.next_run_at}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
