import type Database from "better-sqlite3";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  buildRunDetailFromDisk,
  fileExists,
  readRunMetaFromDisk,
} from "../disk/catalogHelpers.js";
import { runsDir } from "../paths.js";

/**
 * One-shot import of legacy disk run folders into SQLite when the DB has no runs yet.
 */
export async function importDiskRunsIfEmpty(
  db: Database.Database,
  storeRoot: string,
): Promise<number> {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  if (count > 0) return 0;

  const root = runsDir(storeRoot);
  if (!(await fileExists(root))) return 0;

  const entries = await readdir(root, { withFileTypes: true });
  let imported = 0;

  const insertRun = db.prepare(`
    INSERT OR IGNORE INTO runs
      (run_id, pipeline_id, task_id, task_yaml, status, created_at, updated_at, checkout_root)
    VALUES
      (@run_id, @pipeline_id, @task_id, @task_yaml, @status, @created_at, @updated_at, @checkout_root)
  `);
  const upsertStage = db.prepare(`
    INSERT INTO stages
      (run_id, stage_id, status, summary, envelope_json, started_at, finished_at)
    VALUES
      (@run_id, @stage_id, @status, @summary, @envelope_json, @started_at, @finished_at)
    ON CONFLICT(run_id, stage_id) DO UPDATE SET
      status = excluded.status,
      summary = excluded.summary,
      envelope_json = excluded.envelope_json,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at
  `);
  const insertEvent = db.prepare(`
    INSERT INTO stage_events (run_id, stage_id, attempt, at, event, payload_json)
    VALUES (@run_id, @stage_id, @attempt, @at, @event, @payload_json)
  `);
  const insertExecution = db.prepare(`
    INSERT INTO stage_executions
      (run_id, stage_id, attempt, status, started_at, finished_at, envelope_json)
    VALUES
      (@run_id, @stage_id, @attempt, @status, @started_at, @finished_at, @envelope_json)
  `);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = path.join(root, entry.name);
    try {
      if (!(await fileExists(path.join(workspaceDir, "meta.json")))) continue;
      const detail = await buildRunDetailFromDisk(workspaceDir);
      const meta = await readRunMetaFromDisk(workspaceDir);

      db.transaction(() => {
        insertRun.run({
          run_id: detail.run_id,
          pipeline_id: detail.pipeline_id,
          task_id: detail.task_id ?? null,
          task_yaml: detail.task_yaml,
          status: detail.status,
          created_at: detail.created_at,
          updated_at: detail.updated_at ?? meta.updated_at ?? detail.created_at,
          checkout_root: meta.checkout_root ?? null,
        });

        for (const stage of detail.stages) {
          const started = stage.events.find((e) => e.event === "started")?.at ?? null;
          const finished =
            [...stage.events]
              .reverse()
              .find((e) => e.event === "succeeded" || e.event === "failed")?.at ?? null;
          upsertStage.run({
            run_id: detail.run_id,
            stage_id: stage.stage_id,
            status: stage.status,
            summary: stage.envelope?.summary ?? null,
            envelope_json: stage.envelope ? JSON.stringify(stage.envelope) : null,
            started_at: started,
            finished_at: finished,
          });

          insertExecution.run({
            run_id: detail.run_id,
            stage_id: stage.stage_id,
            attempt: 1,
            status: stage.status,
            started_at: started,
            finished_at: finished,
            envelope_json: stage.envelope ? JSON.stringify(stage.envelope) : null,
          });

          for (const ev of stage.events) {
            const { event, at, ...rest } = ev;
            insertEvent.run({
              run_id: detail.run_id,
              stage_id: stage.stage_id,
              attempt: 1,
              at: at ?? new Date().toISOString(),
              event,
              payload_json:
                Object.keys(rest).length > 0 ? JSON.stringify(rest) : null,
            });
          }
        }
      })();

      imported += 1;
    } catch {
      // skip malformed run folders
    }
  }

  return imported;
}
