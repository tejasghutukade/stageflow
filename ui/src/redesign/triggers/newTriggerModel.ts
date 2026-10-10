import type {
  CreateTriggerInput,
  PipelineListing,
  TriggerEvent,
  TriggerSchedule,
} from "../../api";

export const TRIGGER_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type TriggerKind = "manual" | "schedule" | "event";
export type TaskMode = "catalog" | "dynamic";
export type EventSourceKind = "github" | "webhook" | "email";
export type GithubAction = "opened" | "merged" | "closed" | "updated";
export type WebhookScheme = "hex" | "base64";

export const GITHUB_ACTIONS: GithubAction[] = ["opened", "merged", "closed", "updated"];

export const EVENT_SOURCE_IDS: Record<EventSourceKind, string> = {
  github: "github.pull_request",
  webhook: "webhook",
  email: "email.message",
};

export const DEFAULT_CRON = "0 2 * * *";

export const TIMEZONE_OPTIONS = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Kolkata",
];

export type NewTriggerInitial = {
  id: string;
  pipeline: string;
  task?: string;
  kind: TriggerKind;
  enabled: boolean;
  schedule?: { cron?: string; timezone?: string };
  event?: {
    source?: string;
    match?: Record<string, unknown>;
    config?: Record<string, unknown>;
  };
  directory?: string;
  path?: string;
};

export type NewTriggerForm = {
  id: string;
  enabled: boolean;
  kind: TriggerKind;
  pipeline: string;
  taskMode: TaskMode;
  task: string;
  cron: string;
  timezone: string;
  source: EventSourceKind;
  github: { repo: string; secretRef: string; action: GithubAction; author: string };
  webhook: { secretRef: string; header: string; scheme: WebhookScheme };
  email: { host: string; port: string; user: string; secretRef: string; subject: string };
  preserved: {
    source: EventSourceKind;
    match: Record<string, unknown>;
    config: Record<string, unknown>;
  } | null;
};

export type NewTriggerFieldErrors = Partial<
  Record<
    | "id"
    | "pipeline"
    | "task"
    | "cron"
    | "schedule"
    | "repo"
    | "secretRef"
    | "header"
    | "host"
    | "port"
    | "user",
    string
  >
>;

export type UpdateTriggerBody = {
  pipeline: string;
  task?: string | null;
  kind: TriggerKind;
  schedule?: { cron: string; timezone?: string } | null;
  event?: {
    source: string;
    match?: Record<string, unknown>;
    config?: Record<string, unknown>;
  } | null;
  enabled: boolean;
};

export function emptyNewTriggerForm(): NewTriggerForm {
  return {
    id: "",
    enabled: true,
    kind: "event",
    pipeline: "",
    taskMode: "catalog",
    task: "",
    cron: DEFAULT_CRON,
    timezone: "UTC",
    source: "github",
    github: { repo: "", secretRef: "GITHUB_TOKEN", action: "opened", author: "" },
    webhook: { secretRef: "WEBHOOK_SECRET", header: "X-Hub-Signature-256", scheme: "hex" },
    email: { host: "", port: "993", user: "", secretRef: "EMAIL_PASSWORD", subject: "" },
    preserved: null,
  };
}

function sourceKindOf(source: string | undefined): EventSourceKind {
  if (source === "webhook") return "webhook";
  if (source?.startsWith("email")) return "email";
  return "github";
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function omitKeys(
  record: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

const OWNED_CONFIG_KEYS: Record<EventSourceKind, string[]> = {
  github: ["repo", "secretRef"],
  webhook: ["secretRef", "header", "scheme"],
  email: ["host", "port", "user", "secretRef"],
};

const OWNED_MATCH_KEYS: Record<EventSourceKind, string[]> = {
  github: ["action", "author"],
  webhook: [],
  email: ["subject"],
};

export function formFromInitial(initial: NewTriggerInitial | null | undefined): NewTriggerForm {
  const form = emptyNewTriggerForm();
  if (!initial) return form;
  form.id = initial.id;
  form.enabled = initial.enabled;
  form.kind = initial.kind;
  form.pipeline = initial.pipeline;
  form.taskMode = initial.task ? "catalog" : "dynamic";
  form.task = initial.task ?? "";
  if (initial.schedule) {
    form.cron = initial.schedule.cron ?? DEFAULT_CRON;
    form.timezone = initial.schedule.timezone ?? "";
  }
  if (initial.event) {
    const source = sourceKindOf(initial.event.source);
    const match = initial.event.match ?? {};
    const config = initial.event.config ?? {};
    form.source = source;
    if (source === "github") {
      form.github = {
        repo: str(config.repo),
        secretRef: str(config.secretRef),
        action: GITHUB_ACTIONS.includes(match.action as GithubAction)
          ? (match.action as GithubAction)
          : "opened",
        author: str(match.author),
      };
    } else if (source === "webhook") {
      form.webhook = {
        secretRef: str(config.secretRef),
        header: str(config.header),
        scheme: config.scheme === "base64" ? "base64" : "hex",
      };
    } else {
      form.email = {
        host: str(config.host),
        port: str(config.port),
        user: str(config.user),
        secretRef: str(config.secretRef),
        subject: str(match.subject),
      };
    }
    form.preserved = {
      source,
      match: omitKeys(match, OWNED_MATCH_KEYS[source]),
      config: omitKeys(config, OWNED_CONFIG_KEYS[source]),
    };
  }
  return form;
}

export function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

export function validateNewTriggerForm(
  form: NewTriggerForm,
  mode: "create" | "edit",
): NewTriggerFieldErrors {
  const errors: NewTriggerFieldErrors = {};
  if (mode === "create") {
    const id = form.id.trim();
    if (!id) {
      errors.id = "Id is required.";
    } else if (id.length > 64 || !TRIGGER_ID_PATTERN.test(id)) {
      errors.id = "Id must be lowercase kebab-case.";
    }
  }
  if (!form.pipeline) {
    errors.pipeline = "Select a pipeline.";
  }
  if (form.taskMode === "catalog" && !form.task) {
    errors.task = "Select a task.";
  }
  if (form.kind === "schedule") {
    if (!form.cron.trim()) {
      errors.cron = "Cron expression is required.";
    }
    if (form.taskMode === "dynamic") {
      errors.schedule = "Schedule + Dynamic task cannot auto-fire. Pick a catalog task.";
    }
  }
  if (form.kind === "event") {
    if (form.source === "github") {
      if (!GITHUB_REPO_PATTERN.test(form.github.repo.trim())) {
        errors.repo = "Repo must be owner/name.";
      }
    } else if (form.source === "webhook") {
      if (!form.webhook.secretRef.trim()) errors.secretRef = "secretRef is required.";
      if (!form.webhook.header.trim()) errors.header = "Header is required.";
    } else {
      if (!form.email.host.trim()) errors.host = "Host is required.";
      if (parsePort(form.email.port) === null) errors.port = "Port must be 1–65535.";
      if (!form.email.user.trim()) errors.user = "User is required.";
      if (!form.email.secretRef.trim()) errors.secretRef = "secretRef is required.";
    }
  }
  return errors;
}

export function buildTriggerEvent(form: NewTriggerForm): TriggerEvent {
  const source = form.source;
  const keep = form.preserved?.source === source ? form.preserved : null;
  const match: Record<string, unknown> = { ...(keep?.match ?? {}) };
  const config: Record<string, unknown> = { ...(keep?.config ?? {}) };
  if (source === "github") {
    config.repo = form.github.repo.trim();
    if (form.github.secretRef.trim()) config.secretRef = form.github.secretRef.trim();
    match.action = form.github.action;
    if (form.github.author.trim()) match.author = form.github.author.trim();
  } else if (source === "webhook") {
    config.secretRef = form.webhook.secretRef.trim();
    config.header = form.webhook.header.trim();
    if (form.webhook.scheme !== "hex") config.scheme = form.webhook.scheme;
  } else {
    config.host = form.email.host.trim();
    const port = parsePort(form.email.port);
    config.port = port ?? form.email.port.trim();
    config.user = form.email.user.trim();
    config.secretRef = form.email.secretRef.trim();
    if (form.email.subject.trim()) match.subject = form.email.subject.trim();
  }
  return {
    source: EVENT_SOURCE_IDS[source],
    ...(Object.keys(match).length > 0 ? { match } : {}),
    config,
  };
}

function buildSchedule(form: NewTriggerForm): TriggerSchedule {
  const timezone = form.timezone.trim();
  return { cron: form.cron.trim(), ...(timezone ? { timezone } : {}) };
}

export function pipelineDirectoryOf(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : ".";
}

export function directoryForPipeline(
  pipelines: PipelineListing[],
  pipelineId: string,
): string {
  const match = pipelines.find((p) => p.id === pipelineId);
  return match ? pipelineDirectoryOf(match.path) : ".";
}

export function buildCreateTriggerBody(
  form: NewTriggerForm,
  directory: string,
): CreateTriggerInput {
  return {
    directory,
    id: form.id.trim(),
    pipeline: form.pipeline,
    ...(form.taskMode === "catalog" ? { task: form.task } : {}),
    kind: form.kind,
    ...(form.kind === "schedule" ? { schedule: buildSchedule(form) } : {}),
    ...(form.kind === "event" ? { event: buildTriggerEvent(form) } : {}),
    enabled: form.enabled,
  };
}

export function buildUpdateTriggerBody(form: NewTriggerForm): UpdateTriggerBody {
  return {
    pipeline: form.pipeline,
    task: form.taskMode === "catalog" ? form.task : null,
    kind: form.kind,
    schedule: form.kind === "schedule" ? buildSchedule(form) : null,
    event: form.kind === "event" ? buildTriggerEvent(form) : null,
    enabled: form.enabled,
  };
}

export function triggerYamlPath(id: string, initialPath?: string): string {
  if (initialPath) {
    const normalized = initialPath.replace(/\\/g, "/");
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    if (base) return `triggers/${base}`;
  }
  return `triggers/${id.trim() || "…"}.trigger.yaml`;
}

export function triggerFireCommand(id: string): string {
  return `sf trigger fire ${id.trim() || "…"}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function intField(value: string, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n <= max ? n : null;
}

export function describeCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, day, month, wkday] = parts;
  const m = intField(min, 59);
  const h = intField(hour, 23);
  const dailyRest = day === "*" && month === "*";
  if (min === "*" && hour === "*" && dailyRest && wkday === "*") return "Every minute";
  const step = /^\*\/(\d+)$/.exec(min);
  if (step && hour === "*" && dailyRest && wkday === "*") {
    return `Every ${step[1]} minutes`;
  }
  if (m !== null && hour === "*" && dailyRest && wkday === "*") {
    return `Every hour at :${pad2(m)}`;
  }
  if (m === null || h === null || !dailyRest) return null;
  const time = `${pad2(h)}:${pad2(m)}`;
  if (wkday === "*") return `Every day at ${time}`;
  if (wkday === "1-5") return `Weekdays at ${time}`;
  const wd = intField(wkday, 7);
  if (wd !== null) return `Every ${WEEKDAYS[wd % 7]} at ${time}`;
  return null;
}

function dateParts(date: Date, timezone: string): Record<string, string> {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", timezone ? { ...options, timeZone: timezone } : options);
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", options);
  }
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) out[part.type] = part.value;
  return out;
}

export function formatNextRun(
  date: Date,
  now: Date,
  timezone: string,
): { date: string; relative: string } {
  const p = dateParts(date, timezone);
  const label = `${p.weekday} ${p.month} ${p.day} · ${p.hour}:${p.minute}`;
  const minutes = Math.max(0, Math.round((date.getTime() - now.getTime()) / 60000));
  let relative: string;
  if (minutes < 60) {
    relative = `in ${minutes}m`;
  } else if (minutes < 24 * 60) {
    relative = `in ${Math.floor(minutes / 60)}h`;
  } else {
    const days = Math.floor(minutes / (24 * 60));
    const hours = Math.floor((minutes % (24 * 60)) / 60);
    relative = hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
  }
  return { date: label, relative };
}

export function timezoneOptions(current: string): string[] {
  const trimmed = current.trim();
  if (!trimmed || TIMEZONE_OPTIONS.includes(trimmed)) return TIMEZONE_OPTIONS;
  return [...TIMEZONE_OPTIONS, trimmed];
}
