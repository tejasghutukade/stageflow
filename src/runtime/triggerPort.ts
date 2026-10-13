import type { TaskFile } from "../types/task.js";

export type TriggerFireEvent = {
  triggerId: string;
  project_root?: string;
  task?: TaskFile;
};

/**
 * Long-running sources that decide "fire trigger X now". ScheduleSource,
 * GithubPollSource, and EmailSource implement this. Webhook deliveries are
 * request-driven: acceptWebhook shares TriggerFireEvent's optional task, and
 * the HTTP route fires; a webhook is not a start/stop loop.
 */
export interface TriggerSourcePort {
  start(onFire: (event: TriggerFireEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
