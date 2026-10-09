import { useEffect, useState } from "react";
import { fetchEmailTrigger, type EmailTriggerRule } from "../api";
import { triggerPath } from "../routes";

export function emailTriggerLabel(trigger: EmailTriggerRule): string {
  return trigger.task.id;
}

export function emailTriggerFilter(trigger: EmailTriggerRule): string {
  const filters = [`${trigger.accountId} / ${trigger.folder}`];
  if (trigger.from) filters.push(`from ${trigger.from}`);
  if (trigger.subjectContains) filters.push(`subject contains “${trigger.subjectContains}”`);
  return filters.join(" · ");
}

export function EmailTriggerRow({ trigger }: { trigger: EmailTriggerRule }) {
  const href = `#${triggerPath(`email:${trigger.triggerId}`)}`;
  return (
    <tr>
      <td>
        <a href={href}>{emailTriggerLabel(trigger)}</a>
        <div className="muted" style={{ fontSize: "var(--font-size-xs)" }}>
          {trigger.pipeline}
        </div>
        <div className="muted" style={{ fontSize: "var(--font-size-xs)" }}>
          {emailTriggerFilter(trigger)}
        </div>
      </td>
      <td className="mono">Email</td>
      <td className={trigger.enabled ? undefined : "muted"}>
        {trigger.enabled ? "Enabled" : "Disabled"}
      </td>
      <td className="muted">Not tracked here</td>
      <td style={{ textAlign: "right" }}>
        <a className="btn btn--sm" href={href}>Open</a>
      </td>
    </tr>
  );
}

export function EmailTriggerFields({ trigger }: { trigger: EmailTriggerRule }) {
  return (
    <dl className="kv">
      <dt>Pipeline</dt><dd>{trigger.pipeline}</dd>
      <dt>Task</dt><dd>{trigger.task.id}</dd>
      <dt>Goal</dt><dd>{trigger.task.goal}</dd>
      <dt>Kind</dt><dd>Email</dd>
      <dt>Inbox</dt><dd>{trigger.accountId}</dd>
      <dt>Folder</dt><dd>{trigger.folder}</dd>
      <dt>Sender</dt><dd>{trigger.from ?? "Any sender"}</dd>
      <dt>Subject contains</dt><dd>{trigger.subjectContains ?? "Any subject"}</dd>
      <dt>Status</dt><dd>{trigger.enabled ? "Enabled" : "Disabled"}</dd>
      <dt>Active after</dt><dd>{trigger.activeAfter}</dd>
      <dt>Rule ID</dt><dd className="mono">{trigger.triggerId}</dd>
      <dt>Version</dt><dd>{trigger.version}</dd>
      <dt>Message body in task</dt><dd>{trigger.includeBody ? "Included" : "Not included"}</dd>
    </dl>
  );
}

export function EmailTriggerDetail({ triggerId }: { triggerId: string }) {
  const [trigger, setTrigger] = useState<EmailTriggerRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setTrigger(null);
    setError(null);
    void fetchEmailTrigger(triggerId).then(
      (rule) => { if (!cancelled) setTrigger(rule); },
      (err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); },
    ).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [triggerId]);

  return (
    <div className="main__inner">
      <p className="crumbs"><a href="#/triggers">Triggers</a> / Email</p>
      <div className="page-head">
        <div>
          <h1>{trigger ? emailTriggerLabel(trigger) : "Email trigger"}</h1>
          <p>Runs automatically when an incoming email matches this rule. A real message is required; this trigger cannot be fired manually.</p>
        </div>
      </div>
      {error ? <p style={{ color: "var(--color-text-red)" }}>{error}</p> : null}
      {loading ? <p className="muted">Loading email trigger…</p> : null}
      {trigger ? <EmailTriggerFields trigger={trigger} /> : null}
    </div>
  );
}
