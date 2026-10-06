import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";

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
