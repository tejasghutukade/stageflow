import { redact } from "./redact.js";
import { getNamedSecrets } from "./namedSecrets.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFormat = "json" | "pretty";

export type LoggerBindings = {
  component?: string;
  run_id?: string;
  stage_id?: string;
  attempt?: number;
};

export type LogFields = Record<string, unknown>;

export type LogRecord = {
  ts: string;
  level: LogLevel;
  event: string;
  msg: string;
  component?: string;
  run_id?: string;
  stage_id?: string;
  attempt?: number;
  truncated?: boolean;
  original_bytes?: number;
} & LogFields;

export type Logger = {
  debug(event: string, msg: string, fields?: LogFields): void;
  info(event: string, msg: string, fields?: LogFields): void;
  warn(event: string, msg: string, fields?: LogFields): void;
  error(event: string, msg: string, fields?: LogFields): void;
  child(bindings: LoggerBindings): Logger;
};

export const LOG_FORMAT_ENV = "STAGEFLOW_LOG_FORMAT";
export const LOG_LEVEL_ENV = "STAGEFLOW_LOG_LEVEL";
export const LOG_MAX_LINE_BYTES_ENV = "STAGEFLOW_LOG_MAX_LINE_BYTES";

export const DEFAULT_LOG_LEVEL: LogLevel = "info";
export const DEFAULT_LOG_MAX_LINE_BYTES = 8192;

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type CreateLoggerOptions = {
  env?: Record<string, string | undefined>;
  stdoutIsTTY?: boolean;
  format?: LogFormat;
  level?: LogLevel;
  maxLineBytes?: number;
  knownSecrets?: readonly string[];
  bindings?: LoggerBindings;
  write?: (line: string) => void;
  now?: () => Date;
};

export function resolveLogFormat(
  env: Record<string, string | undefined> = process.env,
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
): LogFormat {
  const raw = env[LOG_FORMAT_ENV]?.trim().toLowerCase();
  if (raw === "json" || raw === "pretty") return raw;
  return stdoutIsTTY ? "pretty" : "json";
}

export function resolveLogLevel(
  env: Record<string, string | undefined> = process.env,
): LogLevel {
  const raw = env[LOG_LEVEL_ENV]?.trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return DEFAULT_LOG_LEVEL;
}

export function resolveLogMaxLineBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[LOG_MAX_LINE_BYTES_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_LOG_MAX_LINE_BYTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 64) return DEFAULT_LOG_MAX_LINE_BYTES;
  return n;
}

function formatPretty(record: LogRecord): string {
  const parts = [
    record.ts,
    record.level.toUpperCase(),
    record.component !== undefined ? `[${record.component}]` : undefined,
    `${record.event}:`,
    record.msg,
  ].filter((part): part is string => part !== undefined && part !== "");

  const correlation: string[] = [];
  if (record.run_id !== undefined) correlation.push(`run_id=${record.run_id}`);
  if (record.stage_id !== undefined) {
    correlation.push(`stage_id=${record.stage_id}`);
  }
  if (record.attempt !== undefined) {
    correlation.push(`attempt=${record.attempt}`);
  }
  if (record.truncated === true) correlation.push("truncated=true");

  const reserved = new Set([
    "ts",
    "level",
    "event",
    "msg",
    "component",
    "run_id",
    "stage_id",
    "attempt",
    "truncated",
    "original_bytes",
  ]);
  for (const [key, value] of Object.entries(record)) {
    if (reserved.has(key)) continue;
    if (value === undefined) continue;
    correlation.push(
      `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    );
  }

  return correlation.length > 0
    ? `${parts.join(" ")} ${correlation.join(" ")}`
    : parts.join(" ");
}

function serializeRecord(
  record: LogRecord,
  format: LogFormat,
  maxLineBytes: number,
): string {
  if (format === "pretty") {
    let line = formatPretty(record);
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes <= maxLineBytes) return line;
    const overhead = bytes - Buffer.byteLength(record.msg, "utf8");
    const msgBudget = Math.max(0, maxLineBytes - overhead - 1);
    const truncatedMsg = Buffer.from(record.msg, "utf8")
      .subarray(0, msgBudget)
      .toString("utf8");
    return formatPretty({
      ...record,
      msg: truncatedMsg,
      truncated: true,
      original_bytes: bytes,
    });
  }

  let payload: LogRecord = { ...record };
  let line = JSON.stringify(payload);
  let bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= maxLineBytes) return line;

  const originalBytes = bytes;
  let lo = 0;
  let hi = Buffer.byteLength(record.msg, "utf8");
  let bestMsg = "";
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidateMsg = Buffer.from(record.msg, "utf8")
      .subarray(0, mid)
      .toString("utf8");
    payload = {
      ...record,
      msg: candidateMsg,
      truncated: true,
      original_bytes: originalBytes,
    };
    line = JSON.stringify(payload);
    bytes = Buffer.byteLength(line, "utf8");
    if (bytes <= maxLineBytes) {
      bestMsg = candidateMsg;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return JSON.stringify({
    ...record,
    msg: bestMsg,
    truncated: true,
    original_bytes: originalBytes,
  });
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const env = options.env ?? process.env;
  const format =
    options.format ??
    resolveLogFormat(env, options.stdoutIsTTY ?? Boolean(process.stdout.isTTY));
  const level = options.level ?? resolveLogLevel(env);
  const maxLineBytes = options.maxLineBytes ?? resolveLogMaxLineBytes(env);
  const knownSecrets = options.knownSecrets ?? [];
  const bindings = options.bindings ?? {};
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const now = options.now ?? (() => new Date());

  const emit = (
    recordLevel: LogLevel,
    event: string,
    msg: string,
    fields?: LogFields,
  ): void => {
    if (LEVEL_RANK[recordLevel] < LEVEL_RANK[level]) return;

    const record: LogRecord = {
      ts: now().toISOString(),
      level: recordLevel,
      event,
      msg,
      ...bindings,
      ...fields,
    };

    const redacted = redact(record, {
      knownSecrets,
      namedSecrets: getNamedSecrets(),
    }) as LogRecord;
    write(serializeRecord(redacted, format, maxLineBytes));
  };

  const logger: Logger = {
    debug(event, msg, fields) {
      emit("debug", event, msg, fields);
    },
    info(event, msg, fields) {
      emit("info", event, msg, fields);
    },
    warn(event, msg, fields) {
      emit("warn", event, msg, fields);
    },
    error(event, msg, fields) {
      emit("error", event, msg, fields);
    },
    child(childBindings) {
      return createLogger({
        env,
        format,
        level,
        maxLineBytes,
        knownSecrets,
        write,
        now,
        bindings: { ...bindings, ...childBindings },
      });
    },
  };

  return logger;
}

export const logger: Logger = createLogger({
  bindings: { component: "host" },
});
