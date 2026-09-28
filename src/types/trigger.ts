export type TriggerSchedule = {
  cron: string;
  timezone?: string;
};

export type TriggerEvent = {
  source: string;
  match?: Record<string, unknown>;
};

export type TriggerFile = {
  id: string;
  pipeline: string;
  task?: string;
  kind: "manual" | "schedule" | "event";
  schedule?: TriggerSchedule;
  event?: TriggerEvent;
  enabled: boolean;
};
