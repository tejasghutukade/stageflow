import type {
  CapacityHealth,
  CreatePipelineInput,
  CreatePipelineResult,
  CreateStageInput,
  CreateStageResult,
  CredentialSource,
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
  SettingsSnapshot,
  SkillDiagnostic,
  SkillListing,
  StageAnswer,
  StageListing,
  StartRunResult,
  TaskListing,
  ValidStageListing,
  PackageListing,
  ExtensionFileListing,
} from "./types";

export function isValidStageListing(
  stage: StageListing,
): stage is ValidStageListing {
  return !("error" in stage);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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

export function fetchTasks(): Promise<{ tasks: TaskListing[] }> {
  return api("/api/tasks");
}

export function fetchPipelines(): Promise<{ pipelines: PipelineListing[] }> {
  return api("/api/pipelines");
}

export function fetchStages(): Promise<{ stages: StageListing[] }> {
  return api("/api/stages");
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
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as ValidStageListing & {
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
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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

export function abandonStage(
  runId: string,
  stageId: string,
): Promise<{ ok: true; runId: string; stageId: string }> {
  return api(
    `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/abandon`,
    { method: "POST" },
  );
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
        headers: { "Content-Type": "application/json" },
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

export async function fetchRunArtifact(
  runId: string,
  relativePath: string,
): Promise<string> {
  const res = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(relativePath)}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.text();
}
