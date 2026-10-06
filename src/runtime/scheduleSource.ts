import path from "node:path";
import { Cron } from "croner";
import { getCatalogScanPaths } from "../config/browseCatalog.js";
import { loadTriggerOutcome } from "../config/loadTrigger.js";
import { catalogContextFromStageflow } from "../config/resolveCatalogContext.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import type { RunStore } from "../runstore/port.js";
import type { TriggerSchedule } from "../types/trigger.js";
import type { TriggerFireEvent, TriggerSourcePort } from "./triggerPort.js";

export const DEFAULT_TRIGGER_TICK_INTERVAL_MS = 30_000;

/** Parse `STAGEFLOW_TRIGGER_TICK_INTERVAL_MS`; default 30s; `0` disables. */
export function triggerTickIntervalMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.STAGEFLOW_TRIGGER_TICK_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRIGGER_TICK_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TRIGGER_TICK_INTERVAL_MS;
  return parsed;
}

function computeNextRunAt(schedule: TriggerSchedule, from: Date): Date | null {
  const job = new Cron(
    schedule.cron,
    schedule.timezone !== undefined ? { timezone: schedule.timezone } : {},
  );
  return job.nextRun(from);
}

export type ScheduleSourceOptions = {
  store: RunStore;
  cwd?: string;
  intervalMs?: number;
  /** Injectable clock so tests can drive `tick()` without real timers. */
  now?: () => Date;
  logError?: (message: string) => void;
};

/**
 * `TriggerSourcePort` adapter for `schedule`-kind triggers. Ticks on an
 * interval; each tick re-scans the catalog for enabled `schedule` triggers,
 * seeds `next_run_at` for any that don't have one yet (without firing), and
 * fires any trigger whose `next_run_at` has passed — always recomputing the
 * next fire time from *now*, never from the stale `next_run_at`, so a tick
 * never backfills more than one missed occurrence.
 */
export class ScheduleSource implements TriggerSourcePort {
  private readonly store: RunStore;
  private readonly cwd: string;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly logError: (message: string) => void;
  private interval: NodeJS.Timeout | undefined;
  private inFlight = false;

  constructor(options: ScheduleSourceOptions) {
    this.store = options.store;
    this.cwd = options.cwd ?? process.cwd();
    this.intervalMs = options.intervalMs ?? DEFAULT_TRIGGER_TICK_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.logError =
      options.logError ??
      ((message: string) => {
        console.error(message);
      });
  }

  async start(onFire: (event: TriggerFireEvent) => Promise<void>): Promise<void> {
    if (this.intervalMs <= 0) return;
    this.interval = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      void this.tick(onFire)
        .catch((err) => {
          this.logError(
            `trigger schedule tick failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs).unref();
  }

  async stop(): Promise<void> {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
  }

  /**
   * One discovery + seed + fire pass. Public so tests can drive it directly
   * against an injected clock instead of waiting on real interval timers.
   */
  async tick(onFire: (event: TriggerFireEvent) => Promise<void>): Promise<void> {
    const ctx = catalogContextFromStageflow(await resolveStageflowContext(this.cwd));
    const scanPaths = await getCatalogScanPaths(ctx);
    if (!scanPaths) return;

    const now = this.now();
    const projectRoot = ctx.projectRoot ?? undefined;

    for (const triggerPath of scanPaths.triggerPaths) {
      const outcome = await loadTriggerOutcome(triggerPath);
      if (!outcome.ok) continue;
      const definition = outcome.value;
      if (definition.kind !== "schedule" || !definition.enabled || !definition.schedule) {
        continue;
      }

      let next: Date | null;
      try {
        next = computeNextRunAt(definition.schedule, now);
      } catch (err) {
        this.logError(
          `invalid schedule for trigger "${definition.id}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      const definitionRef =
        projectRoot !== undefined
          ? path.relative(projectRoot, triggerPath).replace(/\\/g, "/")
          : triggerPath;
      await this.store.upsertTrigger({
        id: definition.id,
        definitionRef,
        enabled: true,
      });

      const record = await this.store.getTrigger(definition.id);
      if (!record?.next_run_at) {
        if (next) await this.store.setTriggerNextRun(definition.id, next.toISOString());
        continue;
      }

      const dueAt = new Date(record.next_run_at);
      if (dueAt.getTime() <= now.getTime()) {
        await onFire({ triggerId: definition.id });
        if (next) await this.store.setTriggerNextRun(definition.id, next.toISOString());
      }
    }
  }
}
