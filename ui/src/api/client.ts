import type {
  CapacityHealth,
  CreatePipelineInput,
  CreatePipelineResult,
  CreateStageInput,
  CreateStageResult,
  CredentialSource,
  FeedbackDecisionResult,
  FeedbackLoopDecisionKind,
  LoginSessionMutationResult,
  LoginSessionProjection,
  PipelineListing,
  PiHomeDetectResult,
  ProviderAuthMutationResult,
  ProviderAuthStatus,
  ProvidersListResult,
  RetryStageResult,
  RunDetail,
  RunSummary,
  StageVerificationHistory,
  SettingsSnapshot,
  SkillDiagnostic,
  SkillListing,
  StageAnswer,
  StartRunResult,
  TaskListing,
  CreatedStageListing,
  PackageListing,
  ExtensionFileListing,
  ProjectMcpCatalogList,
  ProjectMcpProbeResult,
  AttachTaskInput,
  AttachTaskResult,
  ClearWorkshopAutosaveResult,
  CreateDraftPackageInput,
  CreateDraftPackageResult,
  CreateWorkshopSessionResult,
  DraftPackagePayload,
  DraftValidationResult,
  GetWorkshopAutosaveResult,
  GetWorkshopSessionResult,
  ListWorkshopSessionsResult,
  OpenDraftPackageInput,
  OpenDraftPackageResult,
  OverwriteDraftPackageInput,
  OverwriteDraftPackageResult,
  PutWorkshopAutosaveResult,
  ValidationFinding,
  WorkshopAutosavePayload,
  WorkshopChatProposalPayload,
  WorkshopChatStreamFrame,
  WorkshopToolCallUpdate,
  WorkshopChatTurnInput,
  WorkshopChatTurnPayload,
  WorkshopChatTurnResult,
  WorkshopDiskChangeInput,
  WorkshopDiskChangeResult,
  WorkshopSessionMutationResult,
  WorkshopSessionRecord,
  WorkshopSessionSummary,
  FocusWorkshopBuildResult,
  GetWorkshopBuildResult,
  ListWorkshopPickerResult,
  UpdateWorkshopSessionActiveBuildResult,
  WorkshopBuildRecord,
  WorkshopPickerRow,
} from "./types";
import { authorizationHeaders } from "./controlToken";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authorizationHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return body;
}

export function fetchRuns(): Promise<{ runs: RunSummary[] }> {
  return api("/api/runs");
}

export function fetchRun(runId: string): Promise<RunDetail> {
  return api(`/api/runs/${encodeURIComponent(runId)}`);
}

export function fetchStageVerification(
  runId: string,
  stageId: string,
): Promise<StageVerificationHistory> {
  return api(
    `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/verification`,
  );
}

export function fetchTasks(): Promise<{ tasks: TaskListing[] }> {
  return api("/api/tasks");
}

export function fetchPipelines(): Promise<{ pipelines: PipelineListing[] }> {
  return api("/api/pipelines");
}

export function fetchModels(): Promise<{ models: string[] }> {
  return api("/api/models");
}

export async function createPipelineWithDetails(
  input: CreatePipelineInput,
): Promise<CreatePipelineResult> {
  try {
    const res = await fetch("/api/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as PipelineListing & {
      error?: string;
    };
    if (res.ok && typeof body.id === "string") {
      return { ok: true, pipeline: body };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function createStageWithDetails(
  input: CreateStageInput,
): Promise<CreateStageResult> {
  try {
    const res = await fetch("/api/stages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as CreatedStageListing & {
      error?: string;
    };
    if (res.ok && typeof body.id === "string") {
      return { ok: true, stage: body };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function fetchSkills(): Promise<{
  skills: SkillListing[];
  diagnostics: SkillDiagnostic[];
}> {
  return api("/api/skills");
}

export function fetchExtensions(): Promise<{
  packages: PackageListing[];
  extensions: ExtensionFileListing[];
}> {
  return api("/api/extensions");
}

export function fetchHealth(): Promise<CapacityHealth> {
  return api("/api/health");
}

export function postSettings(maxConcurrent: number): Promise<CapacityHealth> {
  return api("/api/settings", {
    method: "POST",
    body: JSON.stringify({ maxConcurrent }),
  });
}

export function fetchProviders(): Promise<ProvidersListResult> {
  return api("/api/providers");
}

export function fetchProvidersDetect(): Promise<PiHomeDetectResult> {
  return api("/api/providers/detect");
}

export function fetchProviderAuth(
  providerId: string,
): Promise<{ provider: ProviderAuthStatus }> {
  return api(`/api/providers/${encodeURIComponent(providerId)}/auth`);
}

export async function postProviderApiKey(
  providerId: string,
  apiKey: string,
): Promise<ProviderAuthMutationResult> {
  try {
    const res = await fetch(
      `/api/providers/${encodeURIComponent(providerId)}/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorizationHeaders() },
        body: JSON.stringify({ authType: "api_key", apiKey }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      provider?: ProviderAuthStatus;
      error?: string;
    };
    if (res.ok && body.provider) {
      return { ok: true, provider: body.provider };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function postProviderLogout(
  providerId: string,
): Promise<ProviderAuthMutationResult> {
  try {
    const res = await fetch(
      `/api/providers/${encodeURIComponent(providerId)}/logout`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorizationHeaders() },
        body: JSON.stringify({}),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      provider?: ProviderAuthStatus;
      error?: string;
    };
    if (res.ok && body.provider) {
      return { ok: true, provider: body.provider };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function postProviderOauthLogin(
  providerId: string,
): Promise<LoginSessionMutationResult> {
  try {
    const res = await fetch(
      `/api/providers/${encodeURIComponent(providerId)}/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorizationHeaders() },
        body: JSON.stringify({ authType: "oauth" }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      session?: LoginSessionProjection;
      error?: string;
    };
    if (res.ok && body.session) {
      return { ok: true, session: body.session };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function fetchProviderLoginSession(
  providerId: string,
  sessionId: string,
): Promise<{ session: LoginSessionProjection }> {
  return api(
    `/api/providers/${encodeURIComponent(providerId)}/login/${encodeURIComponent(sessionId)}`,
  );
}

export async function postProviderLoginAnswer(
  providerId: string,
  sessionId: string,
  value: string,
): Promise<LoginSessionMutationResult> {
  try {
    const res = await fetch(
      `/api/providers/${encodeURIComponent(providerId)}/login/${encodeURIComponent(sessionId)}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorizationHeaders() },
        body: JSON.stringify({ value }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      session?: LoginSessionProjection;
      error?: string;
    };
    if (res.ok && body.session) {
      return { ok: true, session: body.session };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function postProviderLoginCancel(
  providerId: string,
  sessionId: string,
): Promise<LoginSessionMutationResult> {
  try {
    const res = await fetch(
      `/api/providers/${encodeURIComponent(providerId)}/login/${encodeURIComponent(sessionId)}/cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorizationHeaders() },
        body: JSON.stringify({}),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      session?: LoginSessionProjection;
      error?: string;
    };
    if (res.ok && body.session) {
      return { ok: true, session: body.session };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function fetchSettings(): Promise<SettingsSnapshot> {
  return api("/api/settings");
}

export function postCredentialSource(
  credentialSource: CredentialSource,
): Promise<SettingsSnapshot> {
  return api("/api/settings", {
    method: "POST",
    body: JSON.stringify({ credentialSource }),
  });
}

export function postWorkshopModel(
  workshopModel: string,
): Promise<SettingsSnapshot> {
  return api("/api/settings", {
    method: "POST",
    body: JSON.stringify({ workshopModel }),
  });
}

export function startRun(task: string, pipeline: string): Promise<{ runId: string }> {
  return api("/api/runs", {
    method: "POST",
    body: JSON.stringify({ task, pipeline }),
  });
}

export async function startRunWithDetails(
  task: string,
  pipeline: string,
): Promise<StartRunResult> {
  try {
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify({ task, pipeline }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      runId?: string;
      error?: string;
      code?: string;
      activeRunIds?: string[];
      conflictingRunId?: string;
    };
    if (res.ok && typeof body.runId === "string") {
      return { ok: true, runId: body.runId };
    }
    return {
      ok: false,
      error: body.error ?? `Request failed (${res.status})`,
      ...(body.code ? { code: body.code } : {}),
      ...(body.activeRunIds ? { activeRunIds: body.activeRunIds } : {}),
      ...(body.conflictingRunId ? { conflictingRunId: body.conflictingRunId } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function rerun(runId: string): Promise<{ runId: string }> {
  return api(`/api/runs/${encodeURIComponent(runId)}/rerun`, {
    method: "POST",
  });
}

export function retryStage(
  runId: string,
  stageId: string,
): Promise<{ runId: string; stageId: string; attemptIndex: number }> {
  return api(
    `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/retry`,
    { method: "POST" },
  );
}

export function resumeTimedOutStage(
  runId: string,
  stageId: string,
): Promise<{ runId: string; stageId: string; attemptIndex: number }> {
  return api(
    `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/resume`,
    { method: "POST" },
  );
}

export function recoverManualStage(
  runId: string,
  stageId: string,
  guidance?: string,
): Promise<{ runId: string; stageId: string; attemptIndex: number }> {
  return api(
    `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/recovery`,
    {
      method: "POST",
      body: JSON.stringify(guidance?.trim() ? { guidance: guidance.trim() } : {}),
    },
  );
}

export function stopManualRecovery(
  runId: string,
  stageId: string,
): Promise<{ ok: true; runId: string; stageId: string }> {
  return api(
    `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/recovery/stop`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function abandonStage(
  runId: string,
  stageId: string,
): Promise<{ ok: true; runId: string; stageId: string }> {
  return api(
    `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/abandon`,
    { method: "POST" },
  );
}

export function cancelRun(
  runId: string,
  reason: string,
): Promise<{ ok: true; runId: string }> {
  return api(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function deleteRun(
  runId: string,
  options?: { force?: boolean },
): Promise<{ ok: true; runId: string }> {
  const force = options?.force === true;
  const qs = force ? "?force=true" : "";
  return api(`/api/runs/${encodeURIComponent(runId)}${qs}`, {
    method: "DELETE",
  });
}

export async function retryStageWithDetails(
  runId: string,
  stageId: string,
): Promise<RetryStageResult> {
  try {
    const res = await fetch(
      `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/retry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      runId?: string;
      stageId?: string;
      attemptIndex?: number;
      error?: string;
      code?: string;
      activeCount?: number;
      maxConcurrent?: number;
      activeRunIds?: string[];
      conflictingRunId?: string;
      conflictingCheckout?: string;
    };
    if (
      res.ok &&
      typeof body.runId === "string" &&
      typeof body.stageId === "string" &&
      typeof body.attemptIndex === "number"
    ) {
      return {
        ok: true,
        runId: body.runId,
        stageId: body.stageId,
        attemptIndex: body.attemptIndex,
      };
    }
    return {
      ok: false,
      error: body.error ?? `Request failed (${res.status})`,
      ...(body.code ? { code: body.code } : {}),
      ...(body.activeCount !== undefined ? { activeCount: body.activeCount } : {}),
      ...(body.maxConcurrent !== undefined ? { maxConcurrent: body.maxConcurrent } : {}),
      ...(body.activeRunIds ? { activeRunIds: body.activeRunIds } : {}),
      ...(body.conflictingRunId ? { conflictingRunId: body.conflictingRunId } : {}),
      ...(body.conflictingCheckout
        ? { conflictingCheckout: body.conflictingCheckout }
        : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function submitStageAnswer(
  runId: string,
  stageId: string,
  answer: StageAnswer,
): Promise<{ ok: true }> {
  return api(
    `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/answer`,
    {
      method: "POST",
      body: JSON.stringify(answer),
    },
  );
}

export function postFeedbackDecision(
  runId: string,
  stageId: string,
  body: {
    decision: FeedbackLoopDecisionKind;
    loopId?: string;
    reason?: string;
  },
): Promise<{ ok: true; effect: string; loopId: string }> {
  return api(
    `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/feedback-decision`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export async function postFeedbackDecisionWithDetails(
  runId: string,
  stageId: string,
  body: {
    decision: FeedbackLoopDecisionKind;
    loopId?: string;
    reason?: string;
  },
): Promise<FeedbackDecisionResult> {
  try {
    const res = await fetch(
      `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/feedback-decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorizationHeaders() },
        body: JSON.stringify(body),
      },
    );
    const parsed = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      effect?: "extended" | "continued" | "abandoned";
      loopId?: string;
      error?: string;
    };
    if (
      res.ok &&
      parsed.ok === true &&
      (parsed.effect === "extended" ||
        parsed.effect === "continued" ||
        parsed.effect === "abandoned") &&
      typeof parsed.loopId === "string"
    ) {
      return { ok: true, effect: parsed.effect, loopId: parsed.loopId };
    }
    return {
      ok: false,
      error: parsed.error ?? `Request failed (${res.status})`,
      status: res.status,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function fetchProjectMcp(): Promise<ProjectMcpCatalogList> {
  return api("/api/project-mcp");
}

export function postProjectMcpProbe(
  name: string,
  init?: { signal?: AbortSignal },
): Promise<ProjectMcpProbeResult> {
  return api(`/api/project-mcp/${encodeURIComponent(name)}/probe`, {
    method: "POST",
    signal: init?.signal,
  });
}

export async function fetchRunArtifact(
  runId: string,
  relativePath: string,
): Promise<string> {
  const res = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(relativePath)}`,
    { headers: { ...authorizationHeaders() } },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.text();
}

export async function validateDraftPackage(
  draft: DraftPackagePayload,
  projectRoot?: string,
): Promise<DraftValidationResult> {
  return api("/api/drafts/validate", {
    method: "POST",
    body: JSON.stringify({
      draft,
      ...(projectRoot ? { project_root: projectRoot } : {}),
    }),
  });
}

export async function createDraftPackageWithDetails(
  input: CreateDraftPackageInput,
): Promise<CreateDraftPackageResult> {
  try {
    const res = await fetch("/api/drafts/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as {
      pipeline?: PipelineListing;
      pipelinePath?: string;
      stagePaths?: string[];
      taskPath?: string;
      error?: string;
      findings?: ValidationFinding[];
    };
    if (
      res.ok &&
      body.pipeline &&
      typeof body.pipelinePath === "string" &&
      Array.isArray(body.stagePaths)
    ) {
      return {
        ok: true,
        pipeline: body.pipeline,
        pipelinePath: body.pipelinePath,
        stagePaths: body.stagePaths,
        ...(body.taskPath !== undefined ? { taskPath: body.taskPath } : {}),
      };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
      ...(body.findings ? { findings: body.findings } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function overwriteDraftPackageWithDetails(
  input: OverwriteDraftPackageInput,
): Promise<OverwriteDraftPackageResult> {
  try {
    const res = await fetch("/api/drafts/overwrite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as {
      pipeline?: PipelineListing;
      pipelinePath?: string;
      stagePaths?: string[];
      taskPath?: string;
      error?: string;
      findings?: ValidationFinding[];
    };
    if (
      res.ok &&
      body.pipeline &&
      typeof body.pipelinePath === "string" &&
      Array.isArray(body.stagePaths)
    ) {
      return {
        ok: true,
        pipeline: body.pipeline,
        pipelinePath: body.pipelinePath,
        stagePaths: body.stagePaths,
        ...(body.taskPath !== undefined ? { taskPath: body.taskPath } : {}),
      };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
      ...(body.findings ? { findings: body.findings } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function openDraftPackage(
  input: OpenDraftPackageInput,
): Promise<OpenDraftPackageResult> {
  try {
    const res = await fetch("/api/drafts/open", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as {
      draft?: DraftPackagePayload;
      destination?: { directory: string; pipelineFilename: string };
      pipelinePath?: string;
      taskPath?: string;
      error?: string;
    };
    if (
      res.ok &&
      body.draft &&
      body.destination &&
      typeof body.pipelinePath === "string"
    ) {
      return {
        ok: true,
        draft: body.draft,
        destination: body.destination,
        pipelinePath: body.pipelinePath,
        ...(body.taskPath !== undefined ? { taskPath: body.taskPath } : {}),
      };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function attachTaskArtifact(
  input: AttachTaskInput,
): Promise<AttachTaskResult> {
  try {
    const res = await fetch("/api/drafts/attach-task", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as {
      task?: { filename: string; body: Record<string, unknown> };
      taskPath?: string;
      error?: string;
    };
    if (
      res.ok &&
      body.task &&
      typeof body.task.filename === "string" &&
      body.task.body &&
      typeof body.taskPath === "string"
    ) {
      return {
        ok: true,
        task: body.task,
        taskPath: body.taskPath,
      };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getWorkshopAutosave(input: {
  key: string;
  project_root?: string;
}): Promise<GetWorkshopAutosaveResult> {
  try {
    const params = new URLSearchParams({ key: input.key });
    if (input.project_root) params.set("project_root", input.project_root);
    const res = await fetch(`/api/workshop/autosave?${params}`, {
      headers: { ...authorizationHeaders() },
    });
    const body = (await res.json().catch(() => ({}))) as {
      key?: string;
      autosave?: WorkshopAutosavePayload | null;
      error?: string;
    };
    if (res.ok && typeof body.key === "string") {
      return {
        ok: true,
        key: body.key,
        autosave: body.autosave ?? null,
      };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function putWorkshopAutosave(
  payload: WorkshopAutosavePayload & { project_root?: string },
): Promise<PutWorkshopAutosaveResult> {
  try {
    const res = await fetch("/api/workshop/autosave", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as {
      autosave?: WorkshopAutosavePayload;
      error?: string;
    };
    if (res.ok && body.autosave) {
      return { ok: true, autosave: body.autosave };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function clearWorkshopAutosave(input: {
  key: string;
  project_root?: string;
}): Promise<ClearWorkshopAutosaveResult> {
  try {
    const res = await fetch("/api/workshop/autosave", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as {
      key?: string;
      cleared?: boolean;
      error?: string;
    };
    if (res.ok && typeof body.key === "string" && typeof body.cleared === "boolean") {
      return { ok: true, key: body.key, cleared: body.cleared };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkWorkshopDiskChange(
  input: WorkshopDiskChangeInput,
): Promise<WorkshopDiskChangeResult> {
  try {
    const res = await fetch("/api/workshop/disk-change", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as {
      fingerprints?: Record<string, string>;
      changed?: boolean;
      changedPaths?: string[];
      error?: string;
    };
    if (
      res.ok &&
      body.fingerprints &&
      typeof body.changed === "boolean" &&
      Array.isArray(body.changedPaths)
    ) {
      return {
        ok: true,
        fingerprints: body.fingerprints,
        changed: body.changed,
        changedPaths: body.changedPaths,
      };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isWorkshopChatTurnPayload(
  body: unknown,
): body is WorkshopChatTurnPayload {
  if (body === null || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    Array.isArray(record.events) &&
    record.draft !== null &&
    typeof record.draft === "object" &&
    typeof record.autoApply === "boolean" &&
    typeof record.model === "string" &&
    (record.pending === null || typeof record.pending === "object")
  );
}

export async function listWorkshopSessions(): Promise<ListWorkshopSessionsResult> {
  try {
    const res = await fetch("/api/workshop/sessions", {
      headers: { ...authorizationHeaders() },
    });
    const body = (await res.json().catch(() => ({}))) as {
      sessions?: WorkshopSessionSummary[];
      error?: string;
    };
    if (res.ok && Array.isArray(body.sessions)) {
      return { ok: true, sessions: body.sessions };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function createWorkshopSession(input?: {
  id?: string;
}): Promise<CreateWorkshopSessionResult> {
  try {
    const res = await fetch("/api/workshop/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(input?.id ? { id: input.id } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as {
      session?: WorkshopSessionRecord;
      error?: string;
    };
    if ((res.ok || res.status === 201) && body.session) {
      return { ok: true, session: body.session };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function listWorkshopPicker(): Promise<ListWorkshopPickerResult> {
  try {
    const res = await fetch("/api/workshop/picker", {
      headers: { ...authorizationHeaders() },
    });
    const body = (await res.json().catch(() => ({}))) as {
      rows?: WorkshopPickerRow[];
      error?: string;
    };
    if (res.ok && Array.isArray(body.rows)) {
      return { ok: true, rows: body.rows };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getWorkshopBuild(
  buildId: string,
): Promise<GetWorkshopBuildResult> {
  try {
    const res = await fetch(
      `/api/workshop/builds/${encodeURIComponent(buildId)}`,
      { headers: { ...authorizationHeaders() } },
    );
    const body = (await res.json().catch(() => ({}))) as {
      build?: WorkshopBuildRecord;
      error?: string;
    };
    if (res.ok && body.build) {
      return { ok: true, build: body.build };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function focusWorkshopBuild(input: {
  projectRoot: string;
  relativePath: string;
}): Promise<FocusWorkshopBuildResult> {
  try {
    const res = await fetch("/api/workshop/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify({
        projectRoot: input.projectRoot,
        relativePath: input.relativePath,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      build?: WorkshopBuildRecord;
      error?: string;
    };
    if ((res.ok || res.status === 201) && body.build) {
      return { ok: true, build: body.build };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function updateWorkshopSessionActiveBuild(input: {
  sessionId: string;
  activeBuildId: string | null;
}): Promise<UpdateWorkshopSessionActiveBuildResult> {
  try {
    const res = await fetch(
      `/api/workshop/sessions/${encodeURIComponent(input.sessionId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...authorizationHeaders(),
        },
        body: JSON.stringify({ activeBuildId: input.activeBuildId }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      session?: WorkshopSessionRecord;
      error?: string;
    };
    if (res.ok && body.session) {
      return { ok: true, session: body.session };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getWorkshopSession(
  sessionId: string,
): Promise<GetWorkshopSessionResult> {
  try {
    const res = await fetch(
      `/api/workshop/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { ...authorizationHeaders() } },
    );
    const body = (await res.json().catch(() => ({}))) as {
      session?: WorkshopSessionRecord;
      error?: string;
      code?: string;
    };
    if (res.ok && body.session) {
      return { ok: true, session: body.session };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
      ...(typeof body.code === "string" ? { code: body.code } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function undoWorkshopSessionMutation(input: {
  sessionId: string;
  draft: DraftPackagePayload;
  mutationId?: string;
}): Promise<WorkshopSessionMutationResult> {
  try {
    const res = await fetch(
      `/api/workshop/sessions/${encodeURIComponent(input.sessionId)}/undo`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authorizationHeaders(),
        },
        body: JSON.stringify({
          draft: input.draft,
          ...(input.mutationId !== undefined
            ? { mutationId: input.mutationId }
            : {}),
        }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as WorkshopSessionMutationResult & {
      error?: string;
      notice?: string;
      reason?: "none" | "id_mismatch" | "conflict";
    };
    if (res.ok && body.ok === true) {
      return body;
    }
    if (body.ok === false || res.status >= 400) {
      return {
        ok: false,
        status: res.status,
        error:
          body.notice ??
          ("error" in body && typeof body.error === "string"
            ? body.error
            : `Request failed (${res.status})`),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        ...(typeof body.notice === "string" ? { notice: body.notice } : {}),
        ...(body.draft ? { draft: body.draft } : {}),
        ...(body.pending !== undefined ? { pending: body.pending } : {}),
        ...(typeof body.sessionId === "string"
          ? { sessionId: body.sessionId }
          : {}),
      };
    }
    return {
      ok: false,
      status: res.status,
      error: `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function acceptWorkshopSessionMutation(input: {
  sessionId: string;
  draft: DraftPackagePayload;
  mutationId?: string;
}): Promise<WorkshopSessionMutationResult> {
  try {
    const res = await fetch(
      `/api/workshop/sessions/${encodeURIComponent(input.sessionId)}/accept`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authorizationHeaders(),
        },
        body: JSON.stringify({
          draft: input.draft,
          ...(input.mutationId !== undefined
            ? { mutationId: input.mutationId }
            : {}),
        }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as WorkshopSessionMutationResult & {
      error?: string;
      notice?: string;
      reason?: "none" | "id_mismatch" | "conflict";
    };
    if (res.ok && body.ok === true) {
      return body;
    }
    if (body.ok === false || res.status >= 400) {
      return {
        ok: false,
        status: res.status,
        error:
          body.notice ??
          ("error" in body && typeof body.error === "string"
            ? body.error
            : `Request failed (${res.status})`),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        ...(typeof body.notice === "string" ? { notice: body.notice } : {}),
        ...(body.draft ? { draft: body.draft } : {}),
        ...(body.pending !== undefined ? { pending: body.pending } : {}),
        ...(typeof body.sessionId === "string"
          ? { sessionId: body.sessionId }
          : {}),
      };
    }
    return {
      ok: false,
      status: res.status,
      error: `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Full-turn Workshop Author chat via Operator Agent Host (JSON). */
export async function sendWorkshopChatTurn(
  input: WorkshopChatTurnInput,
): Promise<WorkshopChatTurnResult> {
  try {
    const res = await fetch("/api/workshop/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify({
        sessionId: input.sessionId,
        message: input.message,
        draft: input.draft,
        autoApply: input.autoApply === true,
        ...(input.model !== undefined ? { model: input.model } : {}),
        stream: false,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as WorkshopChatTurnPayload & {
      error?: string;
    };
    if (res.ok && isWorkshopChatTurnPayload(body)) {
      return { ok: true, ...body };
    }
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Prefer NDJSON stream when the host supports it; fall back to a coherent JSON turn.
 * `onDelta` receives assistant text chunks for progressive UI updates.
 */
export async function stopWorkshopChat(sessionId: string): Promise<{
  draft: DraftPackagePayload | null;
  pending: WorkshopChatProposalPayload | null;
  buildId?: string | null;
} | null> {
  try {
    const res = await fetch("/api/workshop/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      draft?: DraftPackagePayload | null;
      pending?: WorkshopChatProposalPayload | null;
      buildId?: string | null;
    };
    if (!res.ok) return null;
    return {
      draft:
        body.draft !== null && typeof body.draft === "object" ? body.draft : null,
      pending:
        body.pending !== null && typeof body.pending === "object"
          ? body.pending
          : null,
      buildId: typeof body.buildId === "string" && body.buildId ? body.buildId : null,
    };
  } catch {
    return null;
  }
}

export async function sendWorkshopChatTurnStreaming(
  input: WorkshopChatTurnInput,
  handlers: {
    onDelta?: (text: string) => void;
    onActivity?: (update: WorkshopToolCallUpdate) => void;
    onPointerChange?: (frame: {
      buildId: string;
      draft: DraftPackagePayload;
    }) => void;
    onEvent?: (event: WorkshopChatTurnPayload["events"][number]) => void;
    signal?: AbortSignal;
  } = {},
): Promise<WorkshopChatTurnResult> {
  let openedNdjson = false;
  try {
    const res = await fetch("/api/workshop/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        ...authorizationHeaders(),
      },
      body: JSON.stringify({
        sessionId: input.sessionId,
        message: input.message,
        draft: input.draft,
        autoApply: input.autoApply === true,
        ...(input.model !== undefined ? { model: input.model } : {}),
        stream: true,
      }),
      ...(handlers.signal ? { signal: handlers.signal } : {}),
    });

    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        ok: false,
        status: res.status,
        error: body.error ?? `Request failed (${res.status})`,
      };
    }

    if (!contentType.includes("ndjson") || !res.body) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      } & Partial<WorkshopChatTurnPayload>;
      if (isWorkshopChatTurnPayload(body)) {
        return { ok: true, ...body };
      }
      return {
        ok: false,
        status: res.status,
        error: body.error ?? `Request failed (${res.status})`,
      };
    }

    openedNdjson = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const doneBox: { current: WorkshopChatTurnPayload | null } = { current: null };
    let streamError: string | null = null;

    const consumeFrame = (frame: WorkshopChatStreamFrame): void => {
      if (frame.type === "delta") {
        handlers.onDelta?.(frame.text);
      } else if (frame.type === "activity") {
        handlers.onActivity?.(frame);
      } else if (frame.type === "pointer-change") {
        handlers.onPointerChange?.({
          buildId: frame.buildId,
          draft: frame.draft,
        });
      } else if (frame.type === "event") {
        handlers.onEvent?.(frame.event);
        if (
          frame.event.type === "error" &&
          typeof frame.event.message === "string" &&
          frame.event.message
        ) {
          streamError = frame.event.message;
        }
      } else if (frame.type === "done") {
        doneBox.current = {
          sessionId: frame.sessionId,
          events: frame.events ?? [],
          draft: frame.draft,
          pending: frame.pending,
          autoApply: frame.autoApply,
          model: frame.model,
          buildId: frame.buildId ?? null,
        };
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          consumeFrame(JSON.parse(trimmed) as WorkshopChatStreamFrame);
        } catch {
          continue;
        }
      }
    }

    if (buffer.trim()) {
      try {
        consumeFrame(JSON.parse(buffer.trim()) as WorkshopChatStreamFrame);
      } catch {
        /* ignore trailing partial */
      }
    }

    if (doneBox.current) {
      return { ok: true, ...doneBox.current };
    }

    if (streamError) {
      return { ok: false, status: res.status, error: streamError };
    }

    return {
      ok: false,
      status: res.status,
      error: "Stream ended without a done frame",
    };
  } catch (err) {
    if (
      handlers.signal?.aborted ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      return { ok: false, status: 0, error: "Stopped." };
    }
    // JSON fallback only when the server never opened NDJSON.
    if (openedNdjson) {
      return {
        ok: false,
        status: 0,
        error: "Workshop chat stream failed",
      };
    }
    return sendWorkshopChatTurn(input);
  }
}
