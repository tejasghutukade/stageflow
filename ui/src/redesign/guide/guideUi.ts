import { readGuideUi as readGuideUiContract, type GuidePipelineStage, type GuideUi } from "@stageflow/guide-card-contract";
import type { UiPartArtifactRef } from "../../../../src/artifacts/uiPartArtifactRef.ts";
import type { UiPartCard } from "../../../../src/artifacts/uiPartCard.ts";
import { UI_PART_KIND_ARTIFACT_REF, UI_PART_KIND_CARD } from "../../../../src/artifacts/uiPart.ts";
import { parseUiPartEnvelope } from "../../../../src/artifacts/uiPart.ts";
import type { StatusSignal } from "../statusSignal";

export type { GuidePipelineStage, GuideUi };

/** The card payload of a `show_ui` result, or null when it is not one the console can draw. */
export function readGuideUi(result: unknown): GuideUi | null {
  return readGuideUiContract(result);
}

export function readPresentUiCard(result: unknown): UiPartCard | null {
  const parsed = parseUiPartEnvelope(result);
  if (!parsed.ok || parsed.part.kind !== UI_PART_KIND_CARD) return null;
  return parsed.part;
}

export function readSavedCard(result: unknown): UiPartArtifactRef | null {
  const parsed = parseUiPartEnvelope(result);
  if (!parsed.ok || parsed.part.kind !== UI_PART_KIND_ARTIFACT_REF) return null;
  return parsed.part;
}

/** Stages in dependency order; ties keep the authored order, and cycles fall back to it. */
export function orderStages(stages: readonly GuidePipelineStage[]): GuidePipelineStage[] {
  const ids = new Set(stages.map((stage) => stage.id));
  const placed = new Set<string>();
  const ordered: GuidePipelineStage[] = [];
  let remaining = [...stages];
  while (remaining.length > 0) {
    const ready = remaining.filter((stage) => (stage.needs ?? []).every((need) => placed.has(need) || !ids.has(need)));
    const batch = ready.length > 0 ? ready : remaining;
    for (const stage of batch) {
      ordered.push(stage);
      placed.add(stage.id);
    }
    remaining = remaining.filter((stage) => !placed.has(stage.id));
  }
  return ordered;
}

export function resourceSignal(status: string): StatusSignal {
  const value = status.toLowerCase();
  if (/(fail|error|invalid|broken|unhealthy)/.test(value)) return "fail";
  if (/(wait|need|blocked|paused)/.test(value)) return "needs";
  if (/(running|in_progress|started)/.test(value)) return "running";
  if (/(cancel|skip|archiv|disabled|inactive)/.test(value)) return "skipped";
  if (/(\bok\b|valid|succeeded|success|complete|done|passed|enabled|active|ready|connected|healthy)/.test(value)) return "ok";
  return "queued";
}

const EXACT_LABELS: Record<string, [string, string]> = {
  get_started: ["Reading the getting-started guide", "Read the getting-started guide"],
  list_catalog: ["Listing the catalog", "Listed the catalog"],
  start_run: ["Starting a run", "Started a run"],
  stage_action: ["Changing the stage", "Changed the stage"],
  delete_runs: ["Deleting runs", "Deleted runs"],
  review_eval_results: ["Updating eval labels", "Updated eval labels"],
  decide_agent_action: ["Deciding on the agent", "Decided on the agent"],
  set_agent_enabled: ["Changing the agent", "Changed the agent"],
  save_trigger: ["Saving the trigger", "Saved the trigger"],
  get_run: ["Reading the run", "Read the run"],
  get_stage: ["Reading the stage", "Read the stage"],
  run_files: ["Reading run files", "Read run files"],
  write_pipeline: ["Saving the pipeline", "Saved the pipeline"],
  write_stage: ["Saving the stage", "Saved the stage"],
  write_task: ["Saving the task", "Saved the task"],
  save_agent: ["Saving the agent", "Saved the agent"],
  save_eval: ["Saving the eval", "Saved the eval"],
  save_dataset: ["Saving the dataset", "Saved the dataset"],
  save_connection: ["Saving the connection", "Saved the connection"],
  save_memory: ["Saving the memory", "Saved the memory"],
  save_function: ["Saving the function", "Saved the function"],
  get_eval_failures: ["Reading eval failures", "Read eval failures"],
  run_eval: ["Starting an eval run", "Started an eval run"],
  agent_chat: ["Talking to the agent", "Talked to the agent"],
  answer_gate: ["Answering the gate", "Answered the gate"],
  confirm_action: ["Asking you to confirm", "Asked you to confirm"],
  list_guide_topics: ["Looking through Guide topics", "Looked through Guide topics"],
  read_guide_topic: ["Reading a Guide topic", "Read a Guide topic"],
  show_ui: ["Preparing a view", "Showed a view"],
  present_ui: ["Drawing a chart", "Drew a chart"],
  save_card: ["Saving the card", "Saved the card"],
  run_stats: ["Counting runs", "Counted runs"],
  wait_run: ["Waiting for the run", "Waited for the run"],
};

const VERBS: Record<string, [string, string]> = {
  create: ["Creating", "Created"],
  edit: ["Editing", "Edited"],
  update: ["Updating", "Updated"],
  save: ["Saving", "Saved"],
  write: ["Writing", "Wrote"],
  import: ["Importing", "Imported"],
  install: ["Installing", "Installed"],
  convert: ["Converting", "Converted"],
  list: ["Listing", "Listed"],
  get: ["Reading", "Read"],
  read: ["Reading", "Read"],
  describe: ["Reading", "Read"],
  tail: ["Reading", "Read"],
  export: ["Exporting", "Exported"],
  compare: ["Comparing", "Compared"],
  diff: ["Comparing", "Compared"],
  validate: ["Validating", "Validated"],
  test: ["Testing", "Tested"],
  probe: ["Checking", "Checked"],
  try: ["Trying", "Tried"],
  delete: ["Deleting", "Deleted"],
  remove: ["Removing", "Removed"],
  archive: ["Archiving", "Archived"],
  enable: ["Enabling", "Enabled"],
  disable: ["Disabling", "Disabled"],
  set: ["Setting", "Set"],
  cancel: ["Cancelling", "Cancelled"],
  stop: ["Stopping", "Stopped"],
  retry: ["Retrying", "Retried"],
  rerun: ["Rerunning", "Reran"],
  resume: ["Resuming", "Resumed"],
  recover: ["Recovering", "Recovered"],
  abandon: ["Abandoning", "Abandoned"],
  fire: ["Firing", "Fired"],
  approve: ["Approving", "Approved"],
  deny: ["Denying", "Denied"],
  decide: ["Deciding", "Decided"],
  restore: ["Restoring", "Restored"],
  accept: ["Accepting", "Accepted"],
  dismiss: ["Dismissing", "Dismissed"],
  sort: ["Sorting", "Sorted"],
  put: ["Saving", "Saved"],
  gc: ["Cleaning up", "Cleaned up"],
};

/** Plain-language label for a tool call: "Creating pipeline" while it runs, "Created pipeline" after. */
export function toolActivityLabel(name: string, running: boolean): string {
  const exact = EXACT_LABELS[name];
  if (exact) return running ? exact[0] : exact[1];
  const [head, ...rest] = name.split("_");
  const verb = head ? VERBS[head] : undefined;
  if (!verb || rest.length === 0) return name;
  return `${running ? verb[0] : verb[1]} ${rest.join(" ")}`;
}
