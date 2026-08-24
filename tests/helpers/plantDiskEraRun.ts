import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StageLogEvent } from "../../src/runstore/port.js";
import {
  runWorkspaceDir,
  storeRootFor,
} from "../../src/runstore/paths.js";
import {
  attemptEnvelopePath,
  attemptLogPath,
} from "../../src/runstore/workspaceLayout.js";
import type { StageEnvelope } from "../../src/types/envelope.js";

export async function plantDiskEraRun(
  rootDir: string,
  opts: {
    runId: string;
    pipelineId: string;
    taskYaml: string;
    taskId?: string;
    checkoutRoot?: string;
    status?: string;
    createdAt?: string;
    stageId?: string;
    events?: StageLogEvent[];
    envelope?: StageEnvelope;
  },
): Promise<string> {
  const workspaceDir = runWorkspaceDir(storeRootFor(rootDir), opts.runId);
  await mkdir(workspaceDir, { recursive: true });
  const createdAt = opts.createdAt ?? "2020-01-01T00:00:00.000Z";
  const meta: Record<string, unknown> = {
    run_id: opts.runId,
    pipeline_id: opts.pipelineId,
    created_at: createdAt,
    updated_at: createdAt,
  };
  if (opts.status !== undefined) meta.status = opts.status;
  if (opts.taskId !== undefined) meta.task_id = opts.taskId;
  if (opts.checkoutRoot !== undefined) meta.checkout_root = opts.checkoutRoot;
  await writeFile(
    path.join(workspaceDir, "meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
  await writeFile(path.join(workspaceDir, "task.copy.yaml"), opts.taskYaml);

  const stageId = opts.stageId;
  if (stageId !== undefined) {
    if (opts.events && opts.events.length > 0) {
      const logPath = attemptLogPath(workspaceDir, stageId, 1);
      await mkdir(path.dirname(logPath), { recursive: true });
      await writeFile(
        logPath,
        `${opts.events
          .map((event) =>
            JSON.stringify({ ...event, at: event.at ?? createdAt }),
          )
          .join("\n")}\n`,
      );
    }
    if (opts.envelope) {
      const envPath = attemptEnvelopePath(workspaceDir, stageId, 1);
      await mkdir(path.dirname(envPath), { recursive: true });
      await writeFile(envPath, `${JSON.stringify(opts.envelope, null, 2)}\n`);
    }
  }

  return workspaceDir;
}
