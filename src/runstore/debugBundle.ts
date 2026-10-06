import {
  loadHostConfig,
  redactHostConfig,
  type HostConfigPublicEcho,
} from "../config/hostConfig.js";
import { getNamedSecrets } from "../logging/namedSecrets.js";
import { redact } from "../logging/redact.js";
import {
  DEFAULT_DIFF_MAX_BYTES,
  getRunDiff,
} from "../mcp/checkoutTools.js";
import { readStreamLogTail } from "../mcp/tailStreamLog.js";
import {
  buildRunExportPayload,
  type RunExportPayload,
} from "./exportRunPayload.js";
import type { RunStore, StageLogEvent } from "./port.js";
import { readStageVerificationHistory } from "./verificationHistory.js";
import { attemptStreamLogPath } from "./workspaceLayout.js";

export const DEBUG_BUNDLE_EVENTS_MAX_BYTES = 256 * 1024;
export const DEBUG_BUNDLE_VERIFICATION_MAX_BYTES = 256 * 1024;
export const DEBUG_BUNDLE_STREAM_LOG_MAX_BYTES = 64 * 1024;
export const DEBUG_BUNDLE_DIFF_MAX_BYTES = DEFAULT_DIFF_MAX_BYTES;
export const DEBUG_BUNDLE_MAX_STAGES = 64;
export const DEBUG_BUNDLE_MAX_ATTEMPTS_PER_STAGE = 32;

export type DebugCappedMarker = {
  truncated?: boolean;
  original_bytes?: number;
};

export type DebugStageEventsSection = DebugCappedMarker & {
  stages: Array<{
    stage_id: string;
    attempts: Array<{
      attempt: number;
      events: StageLogEvent[];
    }>;
  }>;
};

export type DebugVerificationSection = DebugCappedMarker & {
  stages: Awaited<ReturnType<typeof readStageVerificationHistory>>[];
};

export type DebugStreamLogTail = DebugCappedMarker & {
  stage_id: string;
  attempt: number;
  text: string;
};

export type DebugStreamLogsSection = DebugCappedMarker & {
  tails: DebugStreamLogTail[];
};

export type DebugDiffSection =
  | ({
      available: true;
      mode: "stat" | "patch";
      base_sha: string;
      base_source: "resolved_sha" | "HEAD";
      content: string;
      untracked: string[];
    } & DebugCappedMarker)
  | {
      available: false;
      code?: string;
      error?: string;
    };

export type DebugBundle = RunExportPayload & {
  stage_events: DebugStageEventsSection;
  verification: DebugVerificationSection;
  diff: DebugDiffSection;
  stream_log_tails: DebugStreamLogsSection;
  host_config: HostConfigPublicEcho;
};

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function takeUtf8Tail(
  text: string,
  maxBytes: number,
): { text: string; truncated?: boolean; original_bytes?: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text };
  return {
    text: buf.subarray(buf.length - maxBytes).toString("utf8"),
    truncated: true,
    original_bytes: buf.length,
  };
}

function enforceSectionCap<T extends Record<string, unknown>>(
  section: T,
  maxBytes: number,
  shrink: (full: T) => T,
): T & DebugCappedMarker {
  const encoded = JSON.stringify(section);
  const original_bytes = utf8Bytes(encoded);
  if (original_bytes <= maxBytes) return section;
  return {
    ...shrink(section),
    truncated: true,
    original_bytes,
  };
}

function emptyStageEvents(): DebugStageEventsSection {
  return { stages: [] };
}

function emptyVerification(): DebugVerificationSection {
  return { stages: [] };
}

export async function buildDebugBundle(
  store: RunStore,
  runId: string,
  options: {
    env?: NodeJS.ProcessEnv;
    streamLogMaxBytes?: number;
    eventsMaxBytes?: number;
    verificationMaxBytes?: number;
    diffMaxBytes?: number;
  } = {},
): Promise<DebugBundle> {
  const detail = await store.readRun(runId);
  const exportPayload = buildRunExportPayload(detail);
  const workspaceDir = store.getWorkspaceDir(runId);
  const streamLogMaxBytes =
    options.streamLogMaxBytes ?? DEBUG_BUNDLE_STREAM_LOG_MAX_BYTES;
  const eventsMaxBytes = options.eventsMaxBytes ?? DEBUG_BUNDLE_EVENTS_MAX_BYTES;
  const verificationMaxBytes =
    options.verificationMaxBytes ?? DEBUG_BUNDLE_VERIFICATION_MAX_BYTES;
  const diffMaxBytes = options.diffMaxBytes ?? DEBUG_BUNDLE_DIFF_MAX_BYTES;

  const stageSnapshots = detail.stages.slice(0, DEBUG_BUNDLE_MAX_STAGES);
  const stagesOmitted = detail.stages.length > DEBUG_BUNDLE_MAX_STAGES;

  const stageEventRows: DebugStageEventsSection["stages"] = [];
  const verificationRows: DebugVerificationSection["stages"] = [];
  const streamTails: DebugStreamLogTail[] = [];

  for (const stage of stageSnapshots) {
    const executions = await store.listStageExecutions(runId, stage.stage_id);
    const attemptNums =
      executions.length > 0
        ? executions.map((e) => e.attempt)
        : stage.attempt_count > 0
          ? Array.from({ length: stage.attempt_count }, (_, i) => i + 1)
          : [];
    const cappedAttempts = attemptNums.slice(
      0,
      DEBUG_BUNDLE_MAX_ATTEMPTS_PER_STAGE,
    );

    const attemptEvents: DebugStageEventsSection["stages"][number]["attempts"] =
      [];
    for (const attempt of cappedAttempts) {
      const events = await store.listStageEvents(
        runId,
        stage.stage_id,
        attempt,
      );
      attemptEvents.push({ attempt, events });

      const logPath = attemptStreamLogPath(
        workspaceDir,
        stage.stage_id,
        attempt,
      );
      const tail = await readStreamLogTail(logPath, undefined);
      const capped = takeUtf8Tail(tail.text, streamLogMaxBytes);
      streamTails.push({
        stage_id: stage.stage_id,
        attempt,
        text: capped.text,
        ...(capped.truncated
          ? {
              truncated: true,
              original_bytes: capped.original_bytes,
            }
          : {}),
      });
    }

    if (attemptNums.length === 0) {
      const events = await store.listStageEvents(runId, stage.stage_id);
      attemptEvents.push({ attempt: 0, events });
    }

    stageEventRows.push({
      stage_id: stage.stage_id,
      attempts: attemptEvents,
    });

    verificationRows.push(
      await readStageVerificationHistory(store, runId, stage.stage_id),
    );
  }

  const stage_events = enforceSectionCap(
    {
      stages: stageEventRows,
      ...(stagesOmitted ? { truncated: true as const } : {}),
    } satisfies DebugStageEventsSection,
    eventsMaxBytes,
    () => emptyStageEvents(),
  );

  const verification = enforceSectionCap(
    {
      stages: verificationRows,
      ...(stagesOmitted ? { truncated: true as const } : {}),
    } satisfies DebugVerificationSection,
    verificationMaxBytes,
    () => emptyVerification(),
  );

  const stream_log_tails = enforceSectionCap(
    { tails: streamTails } satisfies DebugStreamLogsSection,
    Math.max(streamLogMaxBytes, streamLogMaxBytes * Math.max(1, streamTails.length)),
    (full) =>
      ({
        tails: full.tails.map((t) => ({
          stage_id: t.stage_id,
          attempt: t.attempt,
          text: "",
          truncated: true as const,
          original_bytes: t.original_bytes ?? utf8Bytes(t.text),
        })),
      }) satisfies DebugStreamLogsSection,
  );

  const diffResult = await getRunDiff(store, runId, {
    mode: "patch",
    maxBytes: diffMaxBytes,
  });
  const diff: DebugDiffSection = diffResult.ok
    ? {
        available: true,
        mode: diffResult.mode,
        base_sha: diffResult.base_sha,
        base_source: diffResult.base_source,
        content: diffResult.content,
        untracked: diffResult.untracked,
        ...(diffResult.truncated ? { truncated: true as const } : {}),
      }
    : {
        available: false,
        code: diffResult.code,
        error: diffResult.error,
      };

  const host_config = redactHostConfig(
    loadHostConfig({ env: options.env ?? process.env }),
  );

  const bundle: DebugBundle = {
    ...exportPayload,
    stage_events,
    verification,
    diff,
    stream_log_tails,
    host_config,
  };

  return redact(bundle as unknown as Record<string, unknown>, {
    namedSecrets: getNamedSecrets(),
  }) as unknown as DebugBundle;
}
