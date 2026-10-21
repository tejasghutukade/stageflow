import type {
  CapacityHealth,
  CreateStageInput,
  CreateStageResult,
  CreateTriggerInput,
  CreateTriggerResult,
  CredentialSource,
  FeedbackDecisionResult,
  FeedbackLoopDecisionKind,
  LoginSessionMutationResult,
  LoginSessionProjection,
  OverviewRange,
  OverviewSummary,
  PipelineListing,
  ProvidersDetectResult,
  ProviderAuthMutationResult,
  ProviderAuthStatus,
  ProvidersListResult,
  RetryStageResult,
  RunDetail,
  RunSummary,
  StageVerificationHistory,
  SettingsSnapshot,
  SkillDiagnostic,
  SkillInstallInput,
  SkillInstallResult,
  SkillListing,
  StageAnswer,
  StartRunResult,
  TaskListing,
  TaskDetailFile,
  CreateTaskInput,
  UpdateTaskBody,
  ImportTaskFromIssueInput,
  TaskWriteResult,
  SkillUsageIndex,
  TriggerListItem,
  TriggerFireRecord,
  EmailTriggerRule,
  ConnectionListing,
  CreatedStageListing,
  PackageListing,
  ExtensionFileListing,
  ChannelConnectionsResult,
  ChannelMeta,
  ChannelHealth,
  ProjectMcpCatalogList,
  ProjectMcpProbeResult,
  ProjectMcpServerConfig,
  ProjectMcpSaveResult,
  ProjectMcpImportResult,
  McpSecretsList,
  McpOAuthStatus,
  McpToolInfo,
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
  DraftPlanResult,
  PlanDraftPackageInput,
  PlanDraftPackageResult,
  PutWorkshopAutosaveResult,
  CatalogFileResult,
  CatalogRootsResult,
  CatalogValidationResult,
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
import { authorizationHeaders, notifyControlTokenRequired } from "./controlToken";

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
  if (res.status === 401) {
    notifyControlTokenRequired();
  }
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

export function fetchTask(id: string): Promise<{ task: TaskDetailFile }> {
  return api(`/api/tasks/${encodeURIComponent(id)}`);
}

async function taskWriteRequest(
  url: string,
  method: "POST" | "PUT",
  input: unknown,
): Promise<TaskWriteResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as {
      task?: TaskDetailFile;
      error?: string;
    };
    if (res.ok && body.task && typeof body.task.id === "string") {
      return { ok: true, task: body.task };
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

export function createTaskWithDetails(input: CreateTaskInput): Promise<TaskWriteResult> {
  return taskWriteRequest("/api/tasks", "POST", input);
}

export function updateTask(id: string, body: UpdateTaskBody): Promise<TaskWriteResult> {
  return taskWriteRequest(`/api/tasks/${encodeURIComponent(id)}`, "PUT", body);
}

export function importTaskFromIssue(input: ImportTaskFromIssueInput): Promise<TaskWriteResult> {
  return taskWriteRequest("/api/tasks/import", "POST", input);
}

export function fetchPipelines(): Promise<{ pipelines: PipelineListing[] }> {
  return api("/api/pipelines");
}

export function fetchTriggers(): Promise<{ triggers: TriggerListItem[] }> {
  return api("/api/triggers");
}

export function fetchEmailTriggers(): Promise<{ triggers: EmailTriggerRule[] }> {
  return api("/api/email/triggers");
}

export async function fetchConnections(): Promise<ConnectionListing[]> {
  const result = await api<{ accounts: {
    accountId: string;
    displayName: string;
    address: string;
    enabled: boolean;
    folders: string[];
  }[] }>("/api/email/accounts");
  return result.accounts.map((account) => ({
    id: account.accountId,
    channel: "Email",
    displayName: account.displayName,
    address: account.address,
    enabled: account.enabled,
    folders: account.folders,
  }));
}

export async function fetchChannelConnections(): Promise<ChannelConnectionsResult> {
  const result = await api<ChannelConnectionsResult>("/api/connections");
  return {
    connections: result.connections.map(({ id, provider, displayName, enabled, identity, credential, secrets, health }) => ({
      id, provider, displayName, enabled,
      ...(secrets ? { secrets: Object.fromEntries(Object.entries(secrets).map(([field, source]) => [field, source === "store" ? "store" : "env"])) as Record<string, "env" | "store"> } : {}),
      ...(identity !== undefined ? { identity } : {}),
      ...(credential !== undefined ? { credential } : {}),
      ...(health ? { health: { state: health.state, checkedAt: health.checkedAt, ...(health.error ? { error: { code: health.error.code, retryable: health.error.retryable } } : {}) } } : {}),
    })),
    ...(result.error ? { error: result.error } : {}),
    limits: { channelsPerStage: Number.isInteger(result.limits?.channelsPerStage) && result.limits.channelsPerStage > 0 ? result.limits.channelsPerStage : 1 },
  };
}

export class ChannelApiError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ChannelApiError";
  }
}

async function channelRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...authorizationHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = (await res.json().catch(() => ({}))) as T & { code?: string };
  if (res.status === 401) notifyControlTokenRequired();
  if (!res.ok) throw new ChannelApiError(typeof parsed.code === "string" ? parsed.code : `HTTP_${res.status}`);
  return parsed;
}

export type NewChannelConnection = {
  provider: string;
  id?: string;
  displayName?: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  credential?: string | { id?: string; secrets: Record<string, string> };
};

export function testChannelConnection(input: NewChannelConnection): Promise<ChannelHealth> {
  return channelRequest("/api/connections/test", "POST", input);
}

export function createChannelConnection(input: NewChannelConnection): Promise<{ id: string; health: ChannelHealth }> {
  return channelRequest("/api/connections", "POST", input);
}

export function updateChannelConnection(
  id: string,
  patch: { displayName?: string | null; enabled?: boolean; config?: Record<string, unknown>; secrets?: Record<string, string> },
): Promise<{ health?: ChannelHealth }> {
  return channelRequest(`/api/connections/${encodeURIComponent(id)}`, "PATCH", patch);
}

export async function deleteChannelConnection(id: string): Promise<void> {
  await channelRequest(`/api/connections/${encodeURIComponent(id)}`, "DELETE");
}

export function fetchChannelMeta(): Promise<ChannelMeta> {
  return api("/api/connections/meta");
}

export function validateChannelTarget(
  connectionId: string,
  target: { to: string | string[]; cc?: string[]; template?: Record<string, unknown> },
): Promise<{ ok: true } | { ok: false; issues: string[] }> {
  return channelRequest(`/api/connections/${encodeURIComponent(connectionId)}/validate-target`, "POST", target);
}

export function checkChannelConnection(id: string): Promise<ChannelHealth> {
  return api(`/api/connections/${encodeURIComponent(id)}/check`, { method: "POST" });
}

export function fetchEmailTrigger(id: string): Promise<EmailTriggerRule> {
  return api(`/api/email/triggers/${encodeURIComponent(id)}`);
}

function triggerRootQuery(projectRoot?: string): string {
  if (!projectRoot) return "";
  return `?${new URLSearchParams({ project_root: projectRoot })}`;
}

export function fetchTrigger(
  id: string,
  projectRoot?: string,
): Promise<TriggerListItem> {
  return api(
    `/api/triggers/${encodeURIComponent(id)}${triggerRootQuery(projectRoot)}`,
  );
}

export function fetchTriggerFires(
  id: string,
  projectRoot?: string,
): Promise<{ fires: TriggerFireRecord[] }> {
  return api(
    `/api/triggers/${encodeURIComponent(id)}/fires${triggerRootQuery(projectRoot)}`,
  );
}

export function patchTrigger(
  id: string,
  body: { enabled: boolean },
  projectRoot?: string,
): Promise<TriggerListItem> {
  return api(
    `/api/triggers/${encodeURIComponent(id)}${triggerRootQuery(projectRoot)}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  );
}

export function updateTrigger(
  id: string,
  body: {
    pipeline: string;
    task?: string | null;
    kind: "manual" | "schedule" | "event";
    schedule?: { cron: string; timezone?: string } | null;
    event?: {
      source: string;
      match?: Record<string, unknown>;
      config?: Record<string, unknown>;
    } | null;
    enabled: boolean;
  },
  projectRoot?: string,
): Promise<TriggerListItem> {
  return api(
    `/api/triggers/${encodeURIComponent(id)}${triggerRootQuery(projectRoot)}`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
  );
}

export function fireTrigger(
  id: string,
  projectRoot?: string,
): Promise<{
  runId: string;
  queued?: boolean;
  queuePosition?: number;
  queuedCode?: string;
}> {
  return api(
    `/api/triggers/${encodeURIComponent(id)}/fire${triggerRootQuery(projectRoot)}`,
    {
      method: "POST",
    },
  );
}

export async function createTriggerWithDetails(
  input: CreateTriggerInput,
): Promise<CreateTriggerResult> {
  try {
    const res = await fetch("/api/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as TriggerListItem & {
      error?: string;
    };
    if (res.ok && typeof body.id === "string") {
      return { ok: true, trigger: body };
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

export type CatalogModel = {
  /** `provider/model`, the form stage, pipeline and agent files store. */
  id: string;
  provider: string;
  name: string;
  free: boolean;
  contextWindow?: number;
  reasoning?: boolean;
  /** The provider runs its own file and shell tools, so agent grants cannot hold. */
  nativeTools: boolean;
};

export type CatalogProvider = {
  id: string;
  name: string;
  models: CatalogModel[];
  source: "live" | "fallback";
  error?: string;
};

export type ModelsResponse = {
  /** Catalog ids plus ids pipelines already use. */
  models: string[];
  /** Connected providers only. */
  providers: CatalogProvider[];
  default: string;
  fetchedAt: string;
  /** Ids in use that no connected provider lists. */
  unlisted: string[];
};

export function fetchModels(): Promise<ModelsResponse> {
  return api("/api/models");
}

/** Asks each connected provider for its current model list. */
export function refreshModels(): Promise<ModelsResponse> {
  return api("/api/models/refresh", { method: "POST" });
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

function skillsQuery(project_root?: string): string {
  if (!project_root) return "";
  return `?${new URLSearchParams({ project_root })}`;
}

export function fetchSkills(project_root?: string): Promise<{
  skills: SkillListing[];
  diagnostics: SkillDiagnostic[];
}> {
  return api(`/api/skills${skillsQuery(project_root)}`);
}

export function fetchSkillUsage(project_root?: string): Promise<SkillUsageIndex> {
  return api(`/api/skills/usage${skillsQuery(project_root)}`);
}

export async function installSkill(
  input: SkillInstallInput,
): Promise<SkillInstallResult> {
  try {
    const res = await fetch("/api/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify({ command: input.command }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      skill_name?: string;
      dest_path?: string;
      skillName?: string;
      destPath?: string;
      message?: string;
      error?: string;
    };
    const skillName =
      typeof body.skill_name === "string"
        ? body.skill_name
        : typeof body.skillName === "string"
          ? body.skillName
          : undefined;
    const destPath =
      typeof body.dest_path === "string"
        ? body.dest_path
        : typeof body.destPath === "string"
          ? body.destPath
          : undefined;
    if (res.ok && skillName !== undefined && destPath !== undefined) {
      return {
        ok: true,
        skillName,
        destPath,
        message:
          typeof body.message === "string"
            ? body.message
            : `Installed ${skillName}`,
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

export function fetchExtensions(): Promise<{
  packages: PackageListing[];
  extensions: ExtensionFileListing[];
}> {
  return api("/api/extensions");
}

export function fetchHealth(): Promise<CapacityHealth> {
  return api("/api/health");
}

export function fetchOverview(range: OverviewRange): Promise<OverviewSummary> {
  return api(`/api/overview?range=${range}`);
}

export function postEnsureProject(projectRoot: string): Promise<{ project_root: string }> {
  return api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ project_root: projectRoot }),
  });
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

export function fetchProvidersDetect(): Promise<ProvidersDetectResult> {
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

export function startRun(
  task: string,
  pipeline: string,
  projectRoot?: string,
): Promise<{ runId: string }> {
  return api("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      task,
      pipeline,
      ...(projectRoot ? { project_root: projectRoot } : {}),
    }),
  });
}

export async function startRunWithDetails(
  task: string,
  pipeline: string,
  projectRoot?: string,
): Promise<StartRunResult> {
  try {
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify({
        task,
        pipeline,
        ...(projectRoot ? { project_root: projectRoot } : {}),
      }),
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

export function fetchProjectMcpServer(
  name: string,
): Promise<{ name: string; origin: "console"; config: ProjectMcpServerConfig }> {
  return api(`/api/project-mcp/${encodeURIComponent(name)}`);
}

export function saveProjectMcpServer(
  name: string,
  config: ProjectMcpServerConfig,
): Promise<ProjectMcpSaveResult> {
  return api(`/api/project-mcp/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ config }),
  });
}

export function deleteProjectMcpServer(name: string): Promise<{ name: string }> {
  return api(`/api/project-mcp/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function importProjectMcp(json: unknown): Promise<ProjectMcpImportResult> {
  return api("/api/project-mcp/import", {
    method: "POST",
    body: JSON.stringify({ json }),
  });
}

/** Tools the Host last saw on this server; `tools` is null when it has never connected. */
export function fetchProjectMcpTools(name: string): Promise<{ name: string; tools: McpToolInfo[] | null }> {
  return api(`/api/project-mcp/${encodeURIComponent(name)}/tools`);
}

export function fetchMcpOAuthStatus(name: string): Promise<{ name: string; status: McpOAuthStatus }> {
  return api(`/api/project-mcp/${encodeURIComponent(name)}/oauth`);
}

export function startMcpOAuthSignIn(name: string): Promise<{ name: string; authorizationUrl: string }> {
  return api(`/api/project-mcp/${encodeURIComponent(name)}/oauth/start`, { method: "POST" });
}

export function completeMcpOAuthSignIn(
  name: string,
  input: string,
): Promise<{ name: string; status: McpOAuthStatus }> {
  return api(`/api/project-mcp/${encodeURIComponent(name)}/oauth/complete`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
}

export function signOutMcpOAuth(name: string): Promise<{ name: string; status: McpOAuthStatus }> {
  return api(`/api/project-mcp/${encodeURIComponent(name)}/oauth`, { method: "DELETE" });
}

export function fetchMcpSecrets(): Promise<McpSecretsList> {
  return api("/api/mcp-secrets");
}

export function setMcpSecretValue(name: string, value: string): Promise<{ name: string }> {
  return api(`/api/mcp-secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

export function deleteMcpSecretValue(name: string): Promise<{ name: string }> {
  return api(`/api/mcp-secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
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
      project_root?: string;
      catalog_root_path?: string;
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
        ...(typeof body.project_root === "string"
          ? { project_root: body.project_root }
          : {}),
        ...(typeof body.catalog_root_path === "string"
          ? { catalog_root_path: body.catalog_root_path }
          : {}),
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
      project_root?: string;
      catalog_root_path?: string;
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
        ...(typeof body.project_root === "string"
          ? { project_root: body.project_root }
          : {}),
        ...(typeof body.catalog_root_path === "string"
          ? { catalog_root_path: body.catalog_root_path }
          : {}),
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

export async function planDraftPackage(
  input: PlanDraftPackageInput,
): Promise<PlanDraftPackageResult> {
  try {
    const res = await fetch("/api/drafts/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<DraftPlanResult> & {
      error?: string;
    };
    if (
      res.ok &&
      typeof body.pipelinePath === "string" &&
      typeof body.directory === "string" &&
      Array.isArray(body.files)
    ) {
      return {
        ok: true,
        pipelinePath: body.pipelinePath,
        directory: body.directory,
        files: body.files,
        pipelineIdTaken: body.pipelineIdTaken === true,
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
      project_root?: string;
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
        ...(typeof body.project_root === "string"
          ? { project_root: body.project_root }
          : {}),
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

export async function putWorkshopBuild(
  buildId: string,
  input: {
    draft?: DraftPackagePayload;
    projectRoot?: string | null;
    relativePath?: string | null;
  },
): Promise<GetWorkshopBuildResult> {
  try {
    const res = await fetch(
      `/api/workshop/builds/${encodeURIComponent(buildId)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...authorizationHeaders(),
        },
        body: JSON.stringify({
          ...(input.draft !== undefined ? { draft: input.draft } : {}),
          ...(input.projectRoot !== undefined
            ? { projectRoot: input.projectRoot }
            : {}),
          ...(input.relativePath !== undefined
            ? { relativePath: input.relativePath }
            : {}),
        }),
      },
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
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.project_root ? { project_root: input.project_root } : {}),
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
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.project_root ? { project_root: input.project_root } : {}),
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

export function fetchCatalogRoots(): Promise<CatalogRootsResult> {
  return api("/api/catalog/roots");
}

export async function fetchCatalogValidate(input: {
  pipeline?: string;
  task?: string;
  stage?: string;
  content?: string;
  strict?: boolean;
  project_root?: string;
}): Promise<CatalogValidationResult> {
  return api("/api/catalog/validate", {
    method: "POST",
    body: JSON.stringify({
      ...(input.pipeline ? { pipeline: input.pipeline } : {}),
      ...(input.task ? { task: input.task } : {}),
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.strict === true ? { strict: true } : {}),
      ...(input.project_root ? { project_root: input.project_root } : {}),
    }),
  });
}

export async function fetchCatalogFile(input: {
  path: string;
  project_root?: string;
}): Promise<CatalogFileResult> {
  const params = new URLSearchParams({ path: input.path });
  if (input.project_root) params.set("project_root", input.project_root);
  return api(`/api/catalog/file?${params}`);
}

export type WriteCatalogFileResult =
  | { ok: true; path: string; content: string }
  | {
      ok: false;
      status: number;
      error: string;
      findings?: ValidationFinding[];
    };

export async function writeCatalogFile(input: {
  path: string;
  content: string;
  project_root?: string;
}): Promise<WriteCatalogFileResult> {
  const res = await fetch("/api/catalog/file", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...authorizationHeaders(),
    },
    body: JSON.stringify({
      path: input.path,
      content: input.content,
      ...(input.project_root ? { project_root: input.project_root } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    path?: string;
    content?: string;
    error?: string;
    findings?: ValidationFinding[];
  };
  if (res.status === 401) {
    notifyControlTokenRequired();
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `Request failed (${res.status})`,
      ...(body.findings ? { findings: body.findings } : {}),
    };
  }
  return {
    ok: true,
    path: body.path ?? input.path,
    content: body.content ?? input.content,
  };
}
