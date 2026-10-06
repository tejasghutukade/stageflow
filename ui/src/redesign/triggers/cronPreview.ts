import { Cron } from "croner";
import type { TriggerSchedule } from "../../api";

export function nextScheduleRuns(
  schedule: TriggerSchedule,
  from: Date,
  count: number,
): Date[] {
  if (!schedule.cron.trim() || count <= 0) return [];
  const job = new Cron(
    schedule.cron,
    schedule.timezone !== undefined ? { timezone: schedule.timezone } : {},
  );
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = job.nextRun(cursor);
    if (!next) break;
    out.push(next);
    cursor = new Date(next.getTime() + 1000);
  }
  return out;
}
