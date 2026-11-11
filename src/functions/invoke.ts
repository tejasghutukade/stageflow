import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scrubSecrets } from "../compaction/scrub.js";
import {
  functionSourceHash,
  type FunctionDefinition,
  type FunctionGrant,
  type FunctionKind,
} from "../config/loadFunction.js";
import { FunctionError } from "./service.js";
import { FunctionBroker, type FunctionBrokerOptions, type FunctionGrants } from "./broker.js";
import {
  diagnosticCode,
  listFunctionInvocations,
  recordFunctionInvocation,
  type FunctionInvocationKind,
  type FunctionInvocationStatus,
  type FunctionInvocationView,
} from "./history.js";
import type { FunctionApiGrant } from "./http.js";
import type { FunctionDial, FunctionLookup } from "./http.js";
import type { FunctionFileGrant } from "./files.js";
import type { FunctionEnvBinding } from "./broker.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { createRunStoreWithConnection } from "../runstore/createStore.js";
import { hostFunctionExecutor } from "./hostExecutor.js";
import { agentProjectKey, FunctionStore } from "./store.js";
import { FunctionService } from "./service.js";
import { callFunctionOnHost, cancelFunctionOnHost, stageFunctionCallsUseHost } from "./workerIpc.js";
import type { FunctionInvokeResult, JsonObject, JsonValue } from "./protocol.js";

export type FunctionTestMocks = {
  files?: Array<{ root: "artifacts" | "workspace"; path: string; text: string }>;
  env?: Record<string, string>;
};

export type FunctionTestInput = {
  source?: string;
  input?: unknown;
  real?: boolean;
  mocks?: FunctionTestMocks;
  timeoutMs?: number;
  memoryLimitBytes?: number;
};

export type FunctionCallInput = {
  functionId: string;
  kind: FunctionKind;
  revision?: number;
  input?: unknown;
  grants?: readonly FunctionGrant[];
  timeoutMs?: number;
  memoryLimitBytes?: number;
  attachmentId?: string | null;
  runId?: string | null;
  stageId?: string | null;
  attempt?: number | null;
  sessionId?: string | null;
  roots?: { artifacts?: string; workspace?: string };
  containerName?: string;
  containerDockerBin?: string;
  invocationId?: string;
};

export type FunctionRunView = {
  ok: boolean;
  value?: JsonValue;
  code?: string;
  message?: string;
  logs: string;
  durationMs: number;
  sourceHash: string;
  revision: number | null;
  kind: FunctionInvocationKind;
  status: FunctionInvocationStatus;
};

export type FunctionInvokerOptions = {
  db: ConstructorParameters<typeof FunctionStore>[0];
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  stageflowHome?: string;
  lookup?: FunctionLookup;
  dial?: FunctionDial;
  forkFn?: FunctionBrokerOptions["forkFn"];
};

const BLOCKED_LOOKUP: FunctionLookup = async () => ["0.0.0.0"];

export function createFunctionInvoker(options: FunctionInvokerOptions): FunctionInvoker {
  return new FunctionInvoker(options);
}

const hostInvokers = new Map<string, FunctionInvoker>();

export function registerHostFunctionInvoker(invoker: FunctionInvoker, home = globalStageflowHome()): void {
  hostInvokers.set(home, invoker);
}

export function hostFunctionInvoker(): FunctionInvoker {
  const home = globalStageflowHome();
  const existing = hostInvokers.get(home);
  if (existing) return existing;
  const { connection } = createRunStoreWithConnection({ rootDir: home });
  const created = createFunctionInvoker({ db: connection, stageflowHome: home });
  hostInvokers.set(home, created);
  return created;
}

export class FunctionInvoker {
  private readonly db: FunctionInvokerOptions["db"];
  private readonly service: FunctionService;
  private readonly broker: FunctionBroker;
  private readonly env: NodeJS.ProcessEnv;
  private readonly lookup: FunctionLookup | undefined;
  private readonly dial: FunctionDial | undefined;

  constructor(options: FunctionInvokerOptions) {
    this.db = options.db;
    this.service = new FunctionService({ store: new FunctionStore(options.db), now: options.now });
    this.env = options.env ?? process.env;
    this.lookup = options.lookup;
    this.dial = options.dial;
    this.broker = new FunctionBroker({
      env: this.env,
      ...(options.stageflowHome ? { stageflowHome: options.stageflowHome } : {}),
      ...(options.forkFn ? { forkFn: options.forkFn } : { executor: hostFunctionExecutor() }),
    });
  }

  async test(projectRoot: string, functionId: string, input: FunctionTestInput = {}): Promise<FunctionRunView> {
    const detail = await this.service.get(projectRoot, functionId);
    if (!detail.definition) throw new FunctionError("function.invalid", "Fix the function file before testing it", { issues: detail.issues });
    const real = input.real === true;
    const source = typeof input.source === "string" ? input.source : detail.definition.source;
    const revision = typeof input.source === "string" ? null : detail.revision;
    const roots = real ? projectRoots(projectRoot) : await mockRoots(input.mocks);
    try {
      return await this.execute({
        projectRoot,
        definition: detail.definition,
        source,
        revision,
        historyKind: "test",
        grants: grantsForDefinition(detail.definition),
        context: input.input,
        timeoutMs: input.timeoutMs ?? detail.definition.timeout_ms,
        memoryLimitBytes: input.memoryLimitBytes,
        real,
        env: real ? this.env : mockEnvironment(input.mocks),
        lookup: real ? this.lookup : BLOCKED_LOOKUP,
        dial: real ? this.dial : undefined,
        roots: { artifacts: roots.artifacts, workspace: roots.workspace },
      });
    } finally {
      if (!real) await roots.cleanup();
    }
  }

  async call(projectRoot: string, input: FunctionCallInput): Promise<FunctionRunView> {
    if (stageFunctionCallsUseHost()) return callFunctionOnHost(input);
    const detail = await this.service.get(projectRoot, input.functionId);
    if (!detail.definition) {
      throw new FunctionError("function.invalid", "Fix the function file before running it", { issues: detail.issues });
    }
    if (input.kind !== detail.definition.kind) {
      return this.refused(projectRoot, detail.definition, detail.revision, "permission_denied", "function kind does not match");
    }
    let definition = detail.definition;
    let revision = detail.revision;
    let sourceHash = detail.sourceHash ?? functionSourceHash(definition.source);
    if (input.revision !== undefined && input.revision !== detail.revision) {
      const pinned = await this.service.getRevision(projectRoot, input.functionId, input.revision);
      definition = pinned.definition;
      revision = pinned.revision;
      sourceHash = pinned.sourceHash;
    }
    const fallback = projectRoots(projectRoot);
    const roots = {
      artifacts: input.roots?.artifacts ?? fallback.artifacts,
      workspace: input.roots?.workspace ?? fallback.workspace,
    };
    return this.execute({
      projectRoot,
      definition,
      source: definition.source,
      sourceHash,
      revision,
      historyKind: historyKind(definition.kind),
      grants: intersectGrants(definition, input.grants ?? []),
      context: input.input,
      timeoutMs: input.timeoutMs ?? definition.timeout_ms,
      memoryLimitBytes: input.memoryLimitBytes,
      real: true,
      env: this.env,
      lookup: this.lookup,
      dial: this.dial,
      roots,
      ...(input.containerName !== undefined ? { containerName: input.containerName } : {}),
      ...(input.containerDockerBin !== undefined ? { containerDockerBin: input.containerDockerBin } : {}),
      attachmentId: input.attachmentId,
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      sessionId: input.sessionId,
      ...(input.invocationId !== undefined ? { invocationId: input.invocationId } : {}),
    });
  }

  list(projectRoot: string, functionId: string): FunctionInvocationView[] {
    return listFunctionInvocations(this.db, agentProjectKey(projectRoot), functionId);
  }

  cancel(invocationId: string): Promise<void> {
    if (stageFunctionCallsUseHost()) {
      cancelFunctionOnHost(invocationId);
      return Promise.resolve();
    }
    return this.broker.cancel(invocationId);
  }

  private refused(
    projectRoot: string,
    definition: FunctionDefinition,
    revision: number | null,
    code: string,
    message: string,
    sourceHash = functionSourceHash(definition.source),
  ): FunctionRunView {
    return this.finish(projectRoot, {
      definition,
      sourceHash,
      revision,
      historyKind: historyKind(definition.kind),
      started: Date.now(),
      result: { ok: false, code, message, logs: "", logsTruncated: false },
      real: true,
    });
  }

  private async execute(input: {
    projectRoot: string;
    definition: FunctionDefinition;
    source: string;
    sourceHash?: string;
    revision: number | null;
    historyKind: FunctionInvocationKind;
    grants: FunctionGrants;
    context: unknown;
    timeoutMs?: number;
    memoryLimitBytes?: number;
    real: boolean;
    env: NodeJS.ProcessEnv;
    lookup?: FunctionLookup;
    dial?: FunctionDial;
    roots: { artifacts: string; workspace: string };
    containerName?: string;
    containerDockerBin?: string;
    attachmentId?: string | null;
    runId?: string | null;
    stageId?: string | null;
    attempt?: number | null;
    sessionId?: string | null;
    invocationId?: string;
  }): Promise<FunctionRunView> {
    const started = Date.now();
    const result = await this.broker.invoke({
      invocationId: input.invocationId ?? randomUUID(),
      kind: input.definition.kind,
      source: input.source,
      context: input.context === undefined ? {} : input.context,
      timeoutMs: input.timeoutMs,
      memoryLimitBytes: input.memoryLimitBytes,
      roots: input.roots,
      ...(input.containerName !== undefined ? { containerName: input.containerName } : {}),
      ...(input.containerDockerBin !== undefined ? { containerDockerBin: input.containerDockerBin } : {}),
      projectRoot: input.projectRoot,
      grants: input.grants,
      env: input.env,
      ...(input.lookup ? { lookup: input.lookup } : {}),
      ...(input.dial ? { dial: input.dial } : {}),
    });
    return this.finish(input.projectRoot, {
      definition: input.definition,
      sourceHash: input.sourceHash ?? functionSourceHash(input.source),
      revision: input.revision,
      historyKind: input.historyKind,
      started,
      result,
      real: input.real,
      attachmentId: input.attachmentId,
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      sessionId: input.sessionId,
    });
  }

  private finish(
    projectRoot: string,
    input: {
      definition: FunctionDefinition;
      sourceHash: string;
      revision: number | null;
      historyKind: FunctionInvocationKind;
      started: number;
      result: FunctionInvokeResult;
      real: boolean;
      attachmentId?: string | null;
      runId?: string | null;
      stageId?: string | null;
      attempt?: number | null;
      sessionId?: string | null;
    },
  ): FunctionRunView {
    const presented = presentResult(input.result, input.real);
    const status = invocationStatus(presented);
    const code = presented.ok ? null : diagnosticCode(presented.code);
    const recorded = recordFunctionInvocation(this.db, {
      projectKey: agentProjectKey(projectRoot),
      functionId: input.definition.id,
      revision: input.revision,
      sourceHash: input.sourceHash,
      kind: input.historyKind,
      status,
      durationMs: Date.now() - input.started,
      code,
      attachmentId: input.attachmentId,
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      sessionId: input.sessionId,
    });
    const logs = scrubSecrets(presented.logs);
    const message = presented.message === undefined ? undefined : scrubSecrets(presented.message);
    return {
      ok: presented.ok,
      ...(presented.value !== undefined ? { value: scrubJson(presented.value) } : {}),
      ...(recorded.code ? { code: recorded.code } : {}),
      ...(message !== undefined ? { message } : {}),
      logs,
      durationMs: recorded.durationMs,
      sourceHash: recorded.sourceHash,
      revision: recorded.revision,
      kind: recorded.kind,
      status: recorded.status,
    };
  }
}

function presentResult(result: FunctionInvokeResult, real: boolean): FunctionInvokeResult {
  if (!real && result.code === "not_found") {
    return { ...result, ok: false, code: "missing_fixture", message: "mock fixture is missing" };
  }
  return result;
}

function invocationStatus(result: FunctionInvokeResult): FunctionInvocationStatus {
  if (result.ok) return "succeeded";
  if (result.code === "uncertain_outcome") return "uncertain";
  return "failed";
}

function historyKind(kind: FunctionKind): FunctionInvocationKind {
  if (kind === "routing") return "route";
  return kind;
}

function projectRoots(projectRoot: string): { artifacts: string; workspace: string; cleanup: () => Promise<void> } {
  return {
    artifacts: path.join(projectRoot, "artifacts"),
    workspace: projectRoot,
    cleanup: async () => undefined,
  };
}

async function mockRoots(mocks: FunctionTestMocks | undefined): Promise<{ artifacts: string; workspace: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-fn-mock-"));
  const artifacts = path.join(root, "artifacts");
  const workspace = path.join(root, "workspace");
  await mkdir(artifacts, { recursive: true });
  await mkdir(workspace, { recursive: true });
  for (const file of mocks?.files ?? []) {
    if ((file.root !== "artifacts" && file.root !== "workspace") || typeof file.path !== "string" || typeof file.text !== "string") continue;
    const base = file.root === "workspace" ? workspace : artifacts;
    const target = containedPath(base, file.path);
    if (!target) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.text);
  }
  return {
    artifacts,
    workspace,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function containedPath(base: string, relative: string): string | undefined {
  if (relative.includes("\0")) return undefined;
  const root = path.resolve(base);
  const target = path.resolve(base, relative);
  if (target !== root && !target.startsWith(root + path.sep)) return undefined;
  return target;
}

function mockEnvironment(mocks: FunctionTestMocks | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(mocks?.env ?? {})) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function grantsForDefinition(definition: FunctionDefinition): FunctionGrants {
  return intersectGrants(
    definition,
    definition.capabilities.map((capability) => ({ id: capability.id })),
  );
}

function intersectGrants(definition: FunctionDefinition, attachment: readonly FunctionGrant[]): FunctionGrants {
  const files: FunctionFileGrant[] = [];
  const env: FunctionEnvBinding[] = [];
  const apis: FunctionApiGrant[] = [];
  const byId = new Map(definition.capabilities.map((capability) => [capability.id, capability]));
  for (const grant of attachment) {
    const capability = byId.get(grant.id);
    if (!capability) continue;
    if (capability.type === "file") {
      if (grant.root !== undefined && grant.root !== capability.root) continue;
      if (grant.path !== undefined && grant.path !== capability.path) continue;
      files.push({ root: capability.root, path: capability.path, access: capability.access });
      continue;
    }
    if (capability.type === "env") {
      const binding = definition.bindings.find((item) => item.alias === capability.alias);
      env.push({ alias: capability.alias, name: capability.alias, required: binding ? binding.required : true });
      continue;
    }
    if (grant.origin !== undefined && grant.origin !== capability.origin) continue;
    if (grant.path_prefix !== undefined && grant.path_prefix !== capability.path_prefix) continue;
    if (grant.credential_ref !== undefined && grant.credential_ref !== capability.credential_ref) continue;
    if (grant.methods !== undefined && grant.methods.some((method) => !capability.methods.includes(method))) continue;
    const methods = grant.methods === undefined ? capability.methods : capability.methods.filter((method) => grant.methods?.includes(method));
    apis.push({
      origin: capability.origin,
      methods,
      pathPrefix: capability.path_prefix,
      access: capability.effect,
      ...(capability.credential_ref ? { credential: capability.credential_ref } : {}),
    });
  }
  return { files, env, apis };
}

function scrubJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return scrubSecrets(value);
  if (Array.isArray(value)) return value.map((item) => scrubJson(item));
  if (value !== null && typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubJson(item);
    return out;
  }
  return value;
}
