import { authorizationHeaders, notifyControlTokenRequired } from "./controlToken";

export type A2aState = "disabled" | "enabled" | "configuration_error";

export type A2aStatus = {
  state: A2aState;
  configPath: string;
  error: { code: string; message: string } | null;
  publicUrl: string;
  agentCardUrl: string;
  callers: number;
  publications: number;
  lastReload: { ok: boolean; at: string; error: { code: string; message: string } | null } | null;
};

export type A2aCaller = { id: string; tokenSource: "store" | "env" };

export type A2aPublication = {
  id: string;
  name: string;
  description: string;
  projectRoot: string;
  pipeline: string;
  goal: string;
  inputSchema: string;
  allowedCallers: string[];
  resultStage: string;
  includePayload: boolean;
  artifacts: string[];
  callerAnswerableStages: string[];
  repository: string | null;
  ref: string | null;
};

export type A2aContract = {
  revision: string;
  inputSchema: unknown;
  outputSchema: unknown;
  artifacts: string[];
};

export type A2aStageOption = { id: string; entry: boolean; terminal: boolean; artifacts: string[]; freeTextOnly: boolean };

export class A2aApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail: string = "",
  ) {
    super(code);
    this.name = "A2aApiError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function problem(value: unknown): { code: string; message: string } | null {
  const raw = asRecord(value);
  return typeof raw.code === "string" ? { code: raw.code, message: text(raw.message) } : null;
}

export function projectA2aStatus(value: unknown): A2aStatus {
  const raw = asRecord(value);
  const reload = asRecord(raw.lastReload);
  return {
    state: raw.state === "enabled" || raw.state === "configuration_error" ? raw.state : "disabled",
    configPath: text(raw.configPath),
    error: problem(raw.error),
    publicUrl: text(raw.publicUrl),
    agentCardUrl: text(raw.agentCardUrl),
    callers: typeof raw.callers === "number" ? raw.callers : 0,
    publications: typeof raw.publications === "number" ? raw.publications : 0,
    lastReload:
      typeof reload.at === "string"
        ? { ok: reload.ok === true, at: reload.at, error: problem(reload.error) }
        : null,
  };
}

export function projectA2aCaller(value: unknown): A2aCaller {
  const raw = asRecord(value);
  return { id: text(raw.id), tokenSource: raw.token_source === "env" ? "env" : "store" };
}

export function projectA2aPublication(value: unknown): A2aPublication {
  const raw = asRecord(value);
  const results = asRecord(raw.results);
  return {
    id: text(raw.id),
    name: text(raw.name),
    description: text(raw.description),
    projectRoot: text(raw.project_root),
    pipeline: text(raw.pipeline),
    goal: text(raw.goal),
    inputSchema: text(raw.input_schema),
    allowedCallers: stringList(raw.allowed_callers),
    resultStage: text(results.stage),
    includePayload: results.include_payload === true,
    artifacts: stringList(results.artifacts),
    callerAnswerableStages: stringList(raw.caller_answerable_stages),
    repository: typeof raw.repository === "string" ? raw.repository : null,
    ref: typeof raw.ref === "string" ? raw.ref : null,
  };
}

export function projectA2aContract(value: unknown): A2aContract {
  const raw = asRecord(value);
  return {
    revision: text(raw.revision),
    inputSchema: raw.inputSchema ?? null,
    outputSchema: raw.outputSchema ?? null,
    artifacts: stringList(raw.artifacts),
  };
}

export function publicationBody(publication: A2aPublication): Record<string, unknown> {
  return {
    id: publication.id,
    name: publication.name,
    description: publication.description,
    project_root: publication.projectRoot,
    pipeline: publication.pipeline,
    goal: publication.goal,
    ...(publication.repository !== null ? { repository: publication.repository } : {}),
    ...(publication.ref !== null ? { ref: publication.ref } : {}),
    allowed_callers: publication.allowedCallers,
    ...(publication.inputSchema ? { input_schema: publication.inputSchema } : {}),
    results: {
      stage: publication.resultStage,
      include_payload: publication.includePayload,
      artifacts: publication.artifacts,
    },
    caller_answerable_stages: publication.callerAnswerableStages,
  };
}

async function request(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...authorizationHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) notifyControlTokenRequired();
  const parsed = (await res.json().catch(() => ({}))) as { code?: unknown; error?: unknown };
  if (!res.ok) {
    const code = typeof parsed.code === "string" && parsed.code.trim() ? parsed.code : `http_${res.status}`;
    throw new A2aApiError(code, res.status, typeof parsed.error === "string" ? parsed.error : "");
  }
  return parsed;
}

const enc = encodeURIComponent;

export const a2aApi = {
  status: async (): Promise<A2aStatus> => projectA2aStatus(await request("/api/a2a/status")),
  enable: async (): Promise<A2aStatus> => projectA2aStatus(await request("/api/a2a/enable", "POST", {})),
  disable: async (): Promise<A2aStatus> => projectA2aStatus(await request("/api/a2a/disable", "POST")),
  reload: async (): Promise<A2aStatus> => projectA2aStatus(await request("/api/a2a/reload", "POST")),
  callers: async (): Promise<A2aCaller[]> => {
    const list = asRecord(await request("/api/a2a/callers")).callers;
    return Array.isArray(list) ? list.map(projectA2aCaller) : [];
  },
  /** The only place a caller's token is read. The caller keeps it in memory until the operator dismisses it. */
  createCaller: async (id: string): Promise<{ id: string; token: string }> => {
    const raw = asRecord(await request("/api/a2a/callers", "POST", { id }));
    return { id: text(raw.id), token: text(raw.token) };
  },
  revokeCaller: async (id: string): Promise<{ removedFrom: string[] }> => {
    const raw = asRecord(await request(`/api/a2a/callers/${enc(id)}`, "DELETE"));
    return { removedFrom: stringList(raw.removed_from) };
  },
  publications: async (): Promise<A2aPublication[]> => {
    const list = asRecord(await request("/api/a2a/publications")).publications;
    return Array.isArray(list) ? list.map(projectA2aPublication) : [];
  },
  previewPublication: async (publication: A2aPublication): Promise<A2aContract> =>
    projectA2aContract(await request("/api/a2a/publications/preview", "POST", publicationBody(publication))),
  createPublication: async (publication: A2aPublication): Promise<A2aPublication> =>
    projectA2aPublication(await request("/api/a2a/publications", "POST", publicationBody(publication))),
  pipelineStages: async (projectRoot: string, pipeline: string): Promise<A2aStageOption[]> => {
    const list = asRecord(
      await request(`/api/a2a/pipeline-stages?project_root=${enc(projectRoot)}&pipeline=${enc(pipeline)}`),
    ).stages;
    return Array.isArray(list)
      ? list.map((value) => {
          const raw = asRecord(value);
          return { id: text(raw.id), entry: raw.entry === true, terminal: raw.terminal === true, artifacts: stringList(raw.artifacts), freeTextOnly: raw.freeTextOnly === true };
        })
      : [];
  },
  schemaFiles: async (projectRoot: string): Promise<{ files: string[]; truncated: boolean }> => {
    const raw = asRecord(await request(`/api/catalog/files?project_root=${enc(projectRoot)}&ext=.json`));
    return { files: stringList(raw.files), truncated: raw.truncated === true };
  },
  updatePublication: async (
    id: string,
    patch: { description?: string; allowedCallers?: string[]; inputSchema?: string },
  ): Promise<A2aPublication> =>
    projectA2aPublication(
      await request(`/api/a2a/publications/${enc(id)}`, "PATCH", {
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.allowedCallers !== undefined ? { allowed_callers: patch.allowedCallers } : {}),
        ...(patch.inputSchema !== undefined ? { input_schema: patch.inputSchema || null } : {}),
      }),
    ),
  removePublication: async (id: string): Promise<void> => {
    await request(`/api/a2a/publications/${enc(id)}`, "DELETE");
  },
};
