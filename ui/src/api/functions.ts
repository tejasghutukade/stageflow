import { authorizationHeaders, notifyControlTokenRequired } from "./controlToken";

export type FunctionKind = "verification" | "routing" | "tool";

export type FunctionOnDiskFormat = "yaml" | "yml" | "js";

export type FunctionIssue = { path: string; code: string; message: string; line?: number; column?: number };

export type FunctionFileCapability = {
  id: string;
  type: "file";
  root: "artifacts" | "workspace";
  path: string;
  access: "read" | "write";
};

export type FunctionEnvCapability = { id: string; type: "env"; alias: string };

export type FunctionApiCapability = {
  id: string;
  type: "api";
  origin: string;
  methods: string[];
  path_prefix: string;
  effect: "read" | "action";
  credential_ref?: string;
};

export type FunctionCapability = FunctionFileCapability | FunctionEnvCapability | FunctionApiCapability;

export type FunctionBinding = { alias: string; required: boolean };

export type FunctionGrant = {
  id: string;
  origin?: string;
  methods?: string[];
  path_prefix?: string;
  credential_ref?: string;
  root?: "artifacts" | "workspace";
  path?: string;
};

export type FunctionDefinition = {
  id: string;
  name: string;
  description?: string;
  kind: FunctionKind;
  source: string;
  timeout_ms: number;
  capabilities: FunctionCapability[];
  bindings: FunctionBinding[];
  tool_name?: string;
  tool_description?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
};

export type FunctionSummary = {
  id: string;
  name: string | null;
  description: string | null;
  kind: FunctionKind | null;
  revision: number;
  issues: FunctionIssue[];
  updatedAt: string;
};

export type FunctionDetail = {
  id: string;
  name: string | null;
  description: string | null;
  kind: FunctionKind | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  issues: FunctionIssue[];
  definition: FunctionDefinition | null;
  yaml: string | null;
  sourceHash: string | null;
  contractVersion: number | null;
  path: string | null;
  format: FunctionOnDiskFormat | null;
};

export type FunctionUsage = { kind: string; path: string };

export type FunctionRevisionMeta = {
  functionId: string;
  revision: number;
  source: string;
  author: string | null;
  summary: string | null;
  sourceHash: string;
  contractVersion: number;
  createdAt: string;
};

export type FunctionInvocation = {
  id: string;
  functionId: string;
  revision: number | null;
  sourceHash: string;
  kind: string;
  status: string;
  durationMs: number;
  code: string | null;
  createdAt: string;
};

export type FunctionRunView = {
  ok: boolean;
  value?: unknown;
  code?: string;
  message?: string;
  logs: string;
  durationMs: number;
  sourceHash: string;
  revision: number | null;
  kind: string;
  status: string;
};

export class FunctionApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly issues: FunctionIssue[] = [],
    readonly currentRevision?: number,
    readonly usages?: FunctionUsage[],
  ) {
    super(message);
    this.name = "FunctionApiError";
  }
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...authorizationHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) notifyControlTokenRequired();
  const parsed = (await res.json().catch(() => ({}))) as T & {
    code?: string;
    message?: string;
    issues?: FunctionIssue[];
    current_revision?: number;
    usages?: FunctionUsage[];
  };
  if (!res.ok) {
    const code = typeof parsed.code === "string" ? parsed.code : `http_${res.status}`;
    throw new FunctionApiError(
      code,
      res.status,
      parsed.message ?? code,
      parsed.issues ?? [],
      typeof parsed.current_revision === "number" ? parsed.current_revision : undefined,
      parsed.usages,
    );
  }
  return parsed;
}

const enc = encodeURIComponent;
const functionUrl = (id: string, tail = "") => `/api/functions/${enc(id)}${tail}`;

export const functionsApi = {
  list: () => request<{ functions: FunctionSummary[] }>("/api/functions").then((body) => body.functions),
  get: (id: string) => request<FunctionDetail>(functionUrl(id)),
  create: (definition: unknown) => request<FunctionDetail>("/api/functions", "POST", { definition }),
  save: (id: string, input: { baseRevision: number; definition: unknown; summary?: string }) =>
    request<FunctionDetail>(functionUrl(id), "PUT", input),
  duplicate: (id: string, newId: string) => request<FunctionDetail>(functionUrl(id, "/duplicate"), "POST", { id: newId }),
  remove: (id: string) => request<{ deleted: true }>(functionUrl(id), "DELETE"),
  test: (id: string, body: Record<string, unknown>) => request<FunctionRunView>(functionUrl(id, "/test"), "POST", body),
  revisions: (id: string) =>
    request<{ revisions: FunctionRevisionMeta[] }>(functionUrl(id, "/revisions")).then((body) => body.revisions),
  invocations: (id: string) =>
    request<{ invocations: FunctionInvocation[] }>(functionUrl(id, "/invocations")).then((body) => body.invocations),
};
