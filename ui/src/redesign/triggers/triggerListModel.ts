import type { RunSummary, TriggerListItem } from "../../api";
import { nextScheduleRuns } from "./cronPreview";

export type TriggerKind = TriggerListItem["kind"];

export const TRIGGER_GROUP_LABEL: Record<TriggerKind, string> = {
  schedule: "Schedule",
  event: "Event",
  manual: "Manual",
};

export const TRIGGER_GROUP_HINT: Record<TriggerKind, string> = {
  schedule: "Cron, checked on every scheduler tick",
  event: "GitHub poll, webhook, or email",
  manual: "Fired from the UI, CLI, or MCP",
};

export const TRIGGERS_INFO_NOTE =
  "GitHub is polled every 60s (the first poll only seeds, no backfill). Email uses IMAP IDLE. Webhooks POST to /api/triggers/:id/webhook and must pass the HMAC check. Dynamic-task triggers build the task from the event payload.";

export type TriggerSourceIcon =
  | "schedule"
  | "manual"
  | "github"
  | "webhook"
  | "email"
  | "event";

export function triggerSourceIcon(trigger: TriggerListItem): TriggerSourceIcon {
  if (trigger.kind === "schedule") return "schedule";
  if (trigger.kind === "manual") return "manual";
  const source = trigger.event?.source ?? "";
  if (source.startsWith("github.")) return "github";
  if (source === "webhook") return "webhook";
  if (source.startsWith("email.")) return "email";
  return "event";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isInt(value: string): boolean {
  return /^\d+$/.test(value);
}

export function humanizeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron.trim();
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return everyMin[1] === "1" ? "Every minute" : `Every ${everyMin[1]} minutes`;
  }
  if (min === "*" && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return "Every minute";
  }
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (isInt(min) && everyHour && dom === "*" && mon === "*" && dow === "*") {
    return everyHour[1] === "1"
      ? `Every hour at :${pad2(Number(min))}`
      : `Every ${everyHour[1]} hours at :${pad2(Number(min))}`;
  }
  if (isInt(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Every hour at :${pad2(Number(min))}`;
  }
  if (!isInt(min) || !isInt(hour)) return cron.trim();
  const time = `${pad2(Number(hour))}:${pad2(Number(min))}`;
  if (dom === "*" && mon === "*") {
    if (dow === "*") return `Every day at ${time}`;
    if (dow === "1-5") return `Weekdays at ${time}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends at ${time}`;
    if (isInt(dow) && Number(dow) <= 7) {
      return `Every ${WEEKDAYS[Number(dow) % 7]} at ${time}`;
    }
  }
  if (isInt(dom) && mon === "*" && dow === "*") {
    return `Monthly on day ${Number(dom)} at ${time}`;
  }
  return cron.trim();
}

export function timezoneLabel(timezone: string): string {
  const last = timezone.split("/").pop() ?? timezone;
  return last.replace(/_/g, " ");
}

function configString(
  config: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export type TriggerSummaryLine = { text: string; warning: boolean };

export function triggerSummaryLine(trigger: TriggerListItem): TriggerSummaryLine {
  if (trigger.kind === "schedule") {
    if (!trigger.task) {
      return { text: "cannot auto-fire: dynamic task on a schedule", warning: true };
    }
    if (!trigger.schedule) return { text: "No schedule", warning: false };
    const human = humanizeCron(trigger.schedule.cron);
    return {
      text: trigger.schedule.timezone
        ? `${human} ${timezoneLabel(trigger.schedule.timezone)}`
        : human,
      warning: false,
    };
  }
  if (trigger.kind === "manual") return { text: "Fired by hand", warning: false };
  if (trigger.adapter_status?.state === "error" && trigger.adapter_status.detail) {
    return { text: trigger.adapter_status.detail, warning: true };
  }
  const source = trigger.event?.source ?? "";
  const config = trigger.event?.config;
  if (source.startsWith("github.")) {
    const action = configString(trigger.event?.match, "action");
    const repo = configString(config, "repo");
    return {
      text: `GitHub PR${action ? ` ${action}` : ""}${repo ? ` in ${repo}` : ""}`,
      warning: false,
    };
  }
  if (source === "webhook") return { text: "Signed webhook", warning: false };
  if (source.startsWith("email.")) {
    const where = configString(config, "host") ?? configString(config, "folder");
    return { text: where ? `Email ${where}` : "Email", warning: false };
  }
  return { text: source || "Event", warning: false };
}

export function formatRelativeFuture(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return "now";
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return "in <1m";
  if (totalMin < 60) return `in ${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) return `in ${totalHr}h`;
  const days = Math.floor(totalHr / 24);
  const hours = totalHr % 24;
  return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
}

export function safeNextRuns(
  trigger: TriggerListItem,
  now: Date,
  count: number,
): Date[] {
  if (trigger.kind !== "schedule" || !trigger.schedule) return [];
  try {
    return nextScheduleRuns(trigger.schedule, now, count);
  } catch {
    return [];
  }
}

export type TriggerNextCell = { label: string; dot: boolean; muted: boolean };

export function triggerNextCell(trigger: TriggerListItem, now: Date): TriggerNextCell {
  const dash = { label: "—", dot: false, muted: true };
  if (!trigger.enabled) return dash;
  if (trigger.kind === "schedule") {
    if (!trigger.task) return dash;
    const [next] = safeNextRuns(trigger, now, 1);
    if (next) return { label: formatRelativeFuture(next, now), dot: false, muted: false };
    if (trigger.next_run_at) {
      return {
        label: formatRelativeFuture(new Date(trigger.next_run_at), now),
        dot: false,
        muted: false,
      };
    }
    return dash;
  }
  if (trigger.kind === "event") {
    const icon = triggerSourceIcon(trigger);
    if (icon === "github") return { label: "polling 60s", dot: true, muted: false };
    if (icon === "webhook") return { label: "webhook", dot: false, muted: false };
    if (icon === "email") return { label: "imap", dot: false, muted: false };
    return dash;
  }
  return dash;
}

export type TriggerFireState = { enabled: boolean; title?: string };

export function triggerFireState(trigger: TriggerListItem): TriggerFireState {
  if (!trigger.enabled) return { enabled: false, title: "Trigger is disabled" };
  if (!trigger.task) return { enabled: false, title: "needs a task payload" };
  return { enabled: true };
}

export type RunOutcome = "succeeded" | "failed";

export function runOutcome(run: RunSummary | undefined): RunOutcome | undefined {
  if (!run) return undefined;
  if (run.status === "succeeded") return "succeeded";
  if (run.status === "failed" || run.status === "cancelled") return "failed";
  return undefined;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${pad2(sec)}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${pad2(min % 60)}m`;
}

export function runDuration(run: RunSummary | undefined): string | undefined {
  if (!run?.finished_at) return undefined;
  const ms = Date.parse(run.finished_at) - Date.parse(run.created_at);
  const label = formatDuration(ms);
  return label || undefined;
}

export function formatCost(usd: number | undefined): string | undefined {
  if (usd === undefined || !Number.isFinite(usd)) return undefined;
  return `$${usd.toFixed(2)}`;
}

export function formatRunDate(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function directoryOf(pathValue: string): string | undefined {
  const normalized = pathValue.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash + 1) : undefined;
}

export function triggerFolderLabel(triggers: TriggerListItem[]): string {
  if (triggers.length === 0) return "triggers/";
  const dirs = new Set(triggers.map((t) => directoryOf(t.definition_ref ?? "")));
  if (dirs.size !== 1) return "triggers/";
  const [only] = [...dirs];
  return only ?? "triggers/";
}

export function triggerFilePath(trigger: Pick<TriggerListItem, "id" | "definition_ref">): string {
  return trigger.definition_ref || `triggers/${trigger.id}.trigger.yaml`;
}

export function triggerBehaviorNotes(kind: TriggerKind): string[] {
  if (kind === "schedule") {
    return [
      "If all agent slots are busy the run is queued.",
      "After downtime, one missed run is caught up on start.",
    ];
  }
  if (kind === "event") return ["If all agent slots are busy the run is queued."];
  return ["Nothing runs until you fire it."];
}

const EVENT_FIELD_KEYS = ["repo", "secretRef", "host", "header", "folder", "url", "mailbox"];

export function triggerEventFields(trigger: TriggerListItem): Array<[string, string]> {
  const config = trigger.event?.config;
  const out: Array<[string, string]> = [];
  for (const key of EVENT_FIELD_KEYS) {
    const value = configString(config, key);
    if (value) out.push([key, value]);
  }
  return out;
}

export function triggerMatchSummary(trigger: TriggerListItem): string | undefined {
  const match = trigger.event?.match;
  if (!match) return undefined;
  const parts = Object.entries(match).map(([key, value]) =>
    `${key}: ${Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value)}`,
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function duplicateTrigger(trigger: TriggerListItem): TriggerListItem {
  return { ...trigger, id: `${trigger.id}-copy` };
}
