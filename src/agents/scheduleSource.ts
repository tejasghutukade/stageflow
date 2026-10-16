import { Cron } from "croner";
import type { AgentSchedule } from "../config/loadAgent.js";
import type { AgentService } from "./service.js";

export const DEFAULT_AGENT_SCHEDULE_TICK_INTERVAL_MS = 30_000;

export function agentScheduleTickIntervalMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.STAGEFLOW_AGENT_SCHEDULE_TICK_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_AGENT_SCHEDULE_TICK_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AGENT_SCHEDULE_TICK_INTERVAL_MS;
  return parsed;
}

function computeNextRunAt(schedule: AgentSchedule, from: Date): Date | null {
  const job = new Cron(
    schedule.cron,
    schedule.timezone !== undefined ? { timezone: schedule.timezone } : {},
  );
  return job.nextRun(from);
}

export type AgentScheduleFireEvent = {
  agentId: string;
  message: string;
};

export type AgentScheduleSourceOptions = {
  service: AgentService;
  projectRoot: string;
  intervalMs?: number;
  now?: () => Date;
  logError?: (message: string) => void;
};

export class AgentScheduleSource {
  private readonly service: AgentService;
  private readonly projectRoot: string;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly logError: (message: string) => void;
  private interval: NodeJS.Timeout | undefined;
  private inFlight = false;

  constructor(options: AgentScheduleSourceOptions) {
    this.service = options.service;
    this.projectRoot = options.projectRoot;
    this.intervalMs = options.intervalMs ?? DEFAULT_AGENT_SCHEDULE_TICK_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.logError =
      options.logError ??
      ((message: string) => {
        console.error(message);
      });
  }

  async start(onFire: (event: AgentScheduleFireEvent) => Promise<void>): Promise<void> {
    if (this.intervalMs <= 0) return;
    this.interval = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      void this.tick(onFire)
        .catch((err) => {
          this.logError(
            `agent schedule tick failed: ${err instanceof Error ? err.message : String(err)}`,
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
   * Fire every enabled agent whose stored next run is due, then store the
   * following occurrence. A host that was down past a due time fires once,
   * not once per missed occurrence.
   */
  async tick(onFire: (event: AgentScheduleFireEvent) => Promise<void>): Promise<void> {
    const now = this.now();
    for (const candidate of await this.service.scheduledAgents(this.projectRoot)) {
      let following: Date | null;
      try {
        following = computeNextRunAt(candidate.schedule, now);
      } catch (err) {
        this.logError(
          `invalid schedule for agent "${candidate.agentId}": ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const stored = this.service.scheduleNextRun(this.projectRoot, candidate.agentId);
      if (stored === undefined) {
        if (following) this.service.setScheduleNextRun(this.projectRoot, candidate.agentId, following.toISOString());
        continue;
      }
      if (Date.parse(stored) > now.getTime()) {
        // A schedule edited to fire sooner must not wait out the old next run.
        if (following && following.getTime() < Date.parse(stored)) {
          this.service.setScheduleNextRun(this.projectRoot, candidate.agentId, following.toISOString());
        }
        continue;
      }
      try {
        await onFire({
          agentId: candidate.agentId,
          message: candidate.schedule.message ?? "Scheduled check-in.",
        });
      } catch (err) {
        this.logError(
          `scheduled turn failed for agent "${candidate.agentId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        if (following) this.service.setScheduleNextRun(this.projectRoot, candidate.agentId, following.toISOString());
      }
    }
  }
}
