import { readFileSync } from "node:fs";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import type { LiveViewMode } from "./liveViewTickets.js";

/** Records carry names, ids and hosts only: never paths, URLs with queries, or cookie values. */
export type AuditRecord =
  | { event: "profile_created"; scope: string; profile: string }
  | { event: "profile_deleted"; scope: string; profile: string }
  | {
      event: "profile_used";
      scope: string;
      profile: string;
      runId: string;
      stageId: string;
    }
  | {
      event: "navigation_outside_allowlist";
      runId: string;
      stageId: string;
      profile?: string;
      host: string;
    }
  | {
      event: "allowlist_unverified";
      runId: string;
      stageId: string;
      profile?: string;
      reason: string;
    }
  | {
      event: "live_view_opened" | "live_view_closed";
      scope: string;
      runId: string;
      stageId: string;
      mode: LiveViewMode;
      callerId: string | null;
    };

export interface AuditSink {
  record(entry: AuditRecord): Promise<void>;
}

export function localAuditLogPath(): string {
  return path.join(globalStageflowHome(), "browser", "audit.jsonl");
}

export function createLocalAuditSink(file?: string): AuditSink {
  return {
    async record(entry) {
      const target = file ?? localAuditLogPath();
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await appendFile(
        target,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
        { mode: 0o600 },
      );
      await chmod(target, 0o600).catch(() => undefined);
    },
  };
}

export function createMemoryAuditSink(): AuditSink & {
  records: AuditRecord[];
} {
  const records: AuditRecord[] = [];
  return {
    records,
    async record(entry) {
      records.push(entry);
    },
  };
}

/** Audit must never break a run. */
export async function safeAudit(
  sink: AuditSink | undefined,
  entry: AuditRecord,
): Promise<void> {
  try {
    await (sink ?? createLocalAuditSink()).record(entry);
  } catch {
    // best-effort
  }
}

/** Profile name to ISO time of its last recorded use, read from the local audit log. */
export async function auditLastUsedByProfile(scope: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(localAuditLogPath(), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const rec = JSON.parse(line) as { at?: string; event?: string; scope?: string; profile?: string };
      if (
        rec.event === "profile_used" &&
        rec.scope === scope &&
        typeof rec.profile === "string" &&
        typeof rec.at === "string" &&
        (out[rec.profile] === undefined || rec.at > out[rec.profile]!)
      ) {
        out[rec.profile] = rec.at;
      }
    } catch {
      // skip bad line
    }
  }
  return out;
}

