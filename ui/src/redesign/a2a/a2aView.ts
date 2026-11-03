import type { A2aCaller, A2aPublication, A2aStageOption, A2aStatus } from "../../api/a2a";

export type A2aScreen = "loading" | "error" | "off" | "configuration_error" | "no_callers" | "ready";

export function a2aScreen(input: {
  loading: boolean;
  loadError: string | null;
  status: A2aStatus | null;
  callers: readonly A2aCaller[];
}): A2aScreen {
  if (input.loading && !input.status) return "loading";
  if (input.loadError && !input.status) return "error";
  if (!input.status) return "loading";
  if (input.status.state === "configuration_error") return "configuration_error";
  if (input.status.state === "disabled") return "off";
  return input.callers.length === 0 ? "no_callers" : "ready";
}

export const CALLER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export function callerNameProblem(name: string, existing: readonly string[]): string | null {
  if (name.length === 0) return null;
  if (!CALLER_NAME_PATTERN.test(name)) return "Use 1 to 80 letters, digits, - or _, starting with a letter or digit.";
  if (existing.includes(name)) return "A caller with this name already exists.";
  return null;
}

export const TOKEN_ONCE_COPY = "Copy this token now. It is shown once and cannot be shown again. If it is lost, revoke the caller and add it again.";

export const OFF_FIRST_COPY = "Turn on A2A so other agents can call the pipelines you publish. Nothing is exposed until you add a caller and publish a pipeline for it.";

export const OFF_KEPT_COPY = "A2A is turned off. Its callers, published pipelines and tokens are kept, and turning it on restores them.";

export const PUBLIC_URL_MISSING_COPY =
  "This Host has no public address, so there is no agent card address to give to other agents. Set the Host's public address (STAGEFLOW_PUBLIC_URL), then turn on A2A again. Hosted workspaces set it for you.";

export function agentCardCommand(agentCardUrl: string): string {
  return `curl -H "Authorization: Bearer <caller token>" ${agentCardUrl}`;
}

export function callingAgentSnippet(agentCardUrl: string): string {
  return [
    `Agent card: ${agentCardUrl}`,
    "Authentication: HTTP header  Authorization: Bearer <caller token>",
    "",
    agentCardCommand(agentCardUrl),
  ].join("\n");
}

export function toggleCaller(allowed: readonly string[], id: string, on: boolean): string[] {
  const without = allowed.filter((entry) => entry !== id);
  return on ? [...without, id] : without;
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry) => b.includes(entry));
}

export function publicationDirty(original: A2aPublication, description: string, allowed: readonly string[]): boolean {
  return description !== original.description || !sameSet(original.allowedCallers, allowed);
}

export function callerUsage(callerId: string, publications: readonly A2aPublication[]): string[] {
  return publications.filter((row) => row.allowedCallers.includes(callerId)).map((row) => row.id);
}

const ERROR_COPY: Record<string, { title: string; hint?: string }> = {
  a2a_public_url_required: { title: "This Host has no public address.", hint: PUBLIC_URL_MISSING_COPY },
  a2a_not_enabled: { title: "A2A is not turned on.", hint: "Turn it on first." },
  a2a_caller_exists: { title: "A caller with this name already exists." },
  a2a_caller_id_retained: {
    title: "That name still has saved tasks.",
    hint: "Tasks are kept for 30 days after they finish. Use another name.",
  },
  a2a_caller_not_found: { title: "That caller no longer exists.", hint: "Reload to see the latest list." },
  a2a_config_invalid: { title: "The A2A configuration was not accepted.", hint: "The previous configuration is still in use." },
  a2a_reload_failed: { title: "The configuration could not be loaded.", hint: "The previous configuration is still in use." },
  a2a_unknown_caller: { title: "A selected caller no longer exists.", hint: "Reload to see the latest list." },
  a2a_publication_not_found: { title: "That published pipeline no longer exists.", hint: "Reload to see the latest list." },
  a2a_publication_invalid: { title: "This publication is not valid." },
  a2a_path_invalid: { title: "A file in this publication is outside its project or missing." },
  a2a_invalid_request: { title: "That request was not accepted." },
  a2a_unavailable: { title: "A2A management is not available on this Host." },
  a2a_management_failed: { title: "A2A could not apply that change." },
  invalid_response: { title: "The Host sent a reply the console could not read." },
  request_failed: { title: "Could not reach the Host.", hint: "Check that it is running, then retry." },
  http_401: { title: "The Host needs its control token.", hint: "Sign in to the console again." },
  http_403: { title: "This console may not manage A2A." },
};

export function a2aErrorCopy(code: string): { title: string; hint?: string; code: string } {
  return { ...(ERROR_COPY[code] ?? { title: "Something went wrong." }), code };
}

export function relativeAt(at: string, now: number): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return at || "—";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function slugifyId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");
}

export function publicationIdProblem(name: string, existing: readonly string[]): string | null {
  if (name.trim().length === 0) return null;
  const id = slugifyId(name);
  if (id.length === 0) return "Use at least one letter or digit in the name.";
  if (existing.includes(id)) return "A published pipeline with this id already exists. Change the name.";
  return null;
}

export function terminalStages(stages: readonly A2aStageOption[]): A2aStageOption[] {
  return stages.filter((stage) => stage.terminal);
}

/** The result stage to select on its own: exactly one terminal stage. */
export function defaultResultStage(stages: readonly A2aStageOption[]): string {
  const terminal = terminalStages(stages);
  return terminal.length === 1 ? terminal[0]!.id : "";
}

export function answerableStages(stages: readonly A2aStageOption[]): A2aStageOption[] {
  return stages.filter((stage) => stage.freeTextOnly);
}

export function artifactsOf(stages: readonly A2aStageOption[], resultStage: string): string[] {
  return stages.find((stage) => stage.id === resultStage && stage.terminal)?.artifacts ?? [];
}

export type NewPublicationForm = {
  projectRoot: string;
  pipeline: string;
  name: string;
  goal: string;
  description: string;
  inputSchema: string;
  resultStage: string;
  includePayload: boolean;
  artifacts: readonly string[];
  answerable: readonly string[];
  allowedCallers: readonly string[];
};

export function newPublicationReady(form: NewPublicationForm, existingIds: readonly string[]): boolean {
  return Boolean(
    form.projectRoot && form.pipeline && form.name.trim() && form.goal.trim() && form.description.trim() &&
      form.inputSchema && form.resultStage && publicationIdProblem(form.name, existingIds) === null && slugifyId(form.name),
  );
}

export function newPublication(form: NewPublicationForm): A2aPublication {
  return {
    id: slugifyId(form.name),
    name: form.name.trim(),
    description: form.description.trim(),
    projectRoot: form.projectRoot,
    pipeline: form.pipeline,
    goal: form.goal.trim(),
    inputSchema: form.inputSchema,
    allowedCallers: [...form.allowedCallers],
    resultStage: form.resultStage,
    includePayload: form.includePayload,
    artifacts: [...form.artifacts],
    callerAnswerableStages: [...form.answerable],
    repository: null,
    ref: null,
  };
}
