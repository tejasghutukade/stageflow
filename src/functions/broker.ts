import { readFileSync } from "node:fs";
import { globalStageflowHome } from "../project/globalHome.js";
import { isForeverDeniedSecret, isProviderOrCloudName } from "../runtime/stageEnvironment.js";
import { loadSecretRegistry, type SecretRegistry } from "../runtime/stageSecrets.js";
import { FunctionExecutor, type FunctionExecutorOptions } from "./executor.js";
import { bindHostFunctionCall, isHostFunctionExecutor, unbindHostFunctionCall } from "./hostExecutor.js";
import { performFileCapability, type ContainerFiles, type FunctionFileGrant } from "./files.js";
import {
  functionApiIsAction,
  performFunctionHttp,
  type FunctionApiGrant,
  type FunctionDial,
  type FunctionLookup,
} from "./http.js";
import {
  type FunctionCapabilityRequest,
  type FunctionCapabilityResult,
  type FunctionInvokeResult,
  type FunctionKind,
  type JsonObject,
  assertJsonObject,
} from "./protocol.js";

export type FunctionEnvBinding = {
  alias: string;
  name: string;
  required?: boolean;
};

export type FunctionGrants = {
  files?: readonly FunctionFileGrant[];
  env?: readonly FunctionEnvBinding[];
  apis?: readonly FunctionApiGrant[];
};

export type FunctionBrokerInvoke = {
  invocationId: string;
  kind: FunctionKind;
  source: string;
  context?: unknown;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  roots?: { artifacts?: string; workspace?: string };
  projectRoot?: string;
  containerName?: string;
  containerDockerBin?: string;
  grants?: FunctionGrants;
  env?: NodeJS.ProcessEnv;
  lookup?: FunctionLookup;
  dial?: FunctionDial;
};

export type FunctionBrokerOptions = {
  executor?: FunctionExecutor;
  env?: NodeJS.ProcessEnv;
  stageflowHome?: string;
  containerFiles?: ContainerFiles;
  lookup?: FunctionLookup;
  dial?: FunctionDial;
  beforeFileCommit?: () => Promise<void> | void;
  forkFn?: FunctionExecutorOptions["forkFn"];
};

type ActiveCall = {
  grants: FunctionGrants;
  artifactsRoot?: string;
  workspaceRoot?: string;
  projectRoot?: string;
  containerName?: string;
  containerDockerBin?: string;
  env: NodeJS.ProcessEnv;
  lookup?: FunctionLookup;
  dial?: FunctionDial;
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class FunctionBroker {
  private readonly executor: FunctionExecutor;
  private readonly usesHostExecutor: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly stageflowHome: string;
  private readonly registry: SecretRegistry;
  private readonly active = new Map<string, ActiveCall>();

  constructor(private readonly options: FunctionBrokerOptions = {}) {
    this.env = options.env ?? process.env;
    this.stageflowHome = options.stageflowHome ?? globalStageflowHome();
    this.registry = loadSecretRegistry(this.env, this.stageflowHome);
    this.usesHostExecutor = options.executor !== undefined && isHostFunctionExecutor(options.executor);
    this.executor =
      options.executor ??
      new FunctionExecutor({
        forkFn: options.forkFn,
        onCapability: (invocationId, request, signal) => this.answer(invocationId, request, signal),
        sideEffect: (invocationId, request) => this.actionDispatched(invocationId, request),
      });
  }

  async invoke(input: FunctionBrokerInvoke): Promise<FunctionInvokeResult> {
    if (input.kind !== "verification" && input.kind !== "routing" && input.kind !== "tool") {
      return failure("invalid_input", "function kind is invalid");
    }
    const grants = input.grants ?? {};
    if (input.kind !== "tool" && hasSideEffect(grants)) {
      return failure("permission_denied", "write access denied");
    }
    const context = input.context === undefined ? { ok: true as const, value: {} } : assertJsonObject(input.context);
    if (!context.ok) return failure("invalid_input", context.message);
    const envSource = input.env ?? this.env;
    const env = resolveEnv(grants.env ?? [], envSource, this.registry);
    if (!env.ok) return failure(env.code, env.message);
    const call: ActiveCall = {
      grants,
      artifactsRoot: input.roots?.artifacts,
      workspaceRoot: input.roots?.workspace,
      projectRoot: input.projectRoot,
      containerName: input.containerName,
      containerDockerBin: input.containerDockerBin,
      env: envSource,
      lookup: input.lookup,
      dial: input.dial,
    };
    this.active.set(input.invocationId, call);
    if (this.usesHostExecutor) {
      bindHostFunctionCall(input.invocationId, {
        answer: (invocationId, request, signal) => this.answer(invocationId, request, signal),
        sideEffect: (invocationId, request) => this.actionDispatched(invocationId, request),
      });
    }
    try {
      return await this.executor.invoke({
        invocationId: input.invocationId,
        source: input.source,
        context: guestContext(context.value, env.env),
        timeoutMs: input.timeoutMs,
        memoryLimitBytes: input.memoryLimitBytes,
      });
    } finally {
      if (this.usesHostExecutor) unbindHostFunctionCall(input.invocationId);
      this.active.delete(input.invocationId);
    }
  }

  cancel(invocationId: string): Promise<void> {
    return this.executor.cancel(invocationId);
  }

  private actionDispatched(invocationId: string, request: FunctionCapabilityRequest): boolean {
    if (request.op !== "http") return false;
    const call = this.active.get(invocationId);
    if (!call) return false;
    return functionApiIsAction(call.grants.apis ?? [], request.method, request.origin, request.path);
  }

  private async answer(
    invocationId: string,
    request: FunctionCapabilityRequest,
    signal: AbortSignal,
  ): Promise<FunctionCapabilityResult> {
    const call = this.active.get(invocationId);
    if (!call || signal.aborted) return capabilityResult(request.requestId, cancelled());
    try {
      const result =
        request.op === "http"
          ? await performFunctionHttp({
              method: request.method,
              origin: request.origin,
              requestPath: request.path,
              body: request.body,
              grants: call.grants.apis ?? [],
              resolveCredential: (name) => credentialValue(this.registry, call.env, name),
              lookup: call.lookup ?? this.options.lookup,
              dial: call.dial ?? this.options.dial,
              signal,
            })
          : await performFileCapability({
              op: request.op,
              root: request.root,
              filePath: request.path,
              content: request.content,
              grants: call.grants.files ?? [],
              artifactsRoot: call.artifactsRoot,
              workspaceRoot: call.workspaceRoot,
              projectRoot: call.projectRoot,
              stageflowHome: this.stageflowHome,
              containerName: call.containerName,
              containerDockerBin: call.containerDockerBin,
              containerFiles: this.options.containerFiles,
              signal,
              beforeCommit: this.options.beforeFileCommit,
            });
      if (signal.aborted && request.op !== "write") return capabilityResult(request.requestId, cancelled());
      return capabilityResult(request.requestId, result);
    } catch {
      if (signal.aborted) {
        return capabilityResult(request.requestId, request.op === "write" ? uncertain() : cancelled());
      }
      return capabilityResult(request.requestId, {
        ok: false,
        code: "exception",
        message: "capability failed",
      });
    }
  }
}

function guestContext(context: JsonObject, env: Record<string, string>): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(context)) {
    if (key === "env" || key === "files" || key === "http" || key === "log" || key === "signal") continue;
    out[key] = value;
  }
  out.env = env;
  return out;
}

function resolveEnv(
  bindings: readonly FunctionEnvBinding[],
  env: NodeJS.ProcessEnv,
  registry: SecretRegistry,
): { ok: true; env: Record<string, string> } | { ok: false; code: string; message: string } {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (!NAME.test(binding.alias) || !NAME.test(binding.name) || seen.has(binding.alias)) {
      return { ok: false, code: "permission_denied", message: "environment binding denied" };
    }
    seen.add(binding.alias);
    if (isForeverDeniedSecret(binding.name) || isProviderOrCloudName(binding.name) || registry.has(binding.name)) {
      return { ok: false, code: "permission_denied", message: "environment binding denied" };
    }
    const value = env[binding.name];
    if (value === undefined || value === "") {
      if (binding.required === false) continue;
      return { ok: false, code: "missing_binding", message: "required environment binding is missing" };
    }
    out[binding.alias] = value;
  }
  return { ok: true, env: out };
}

function credentialValue(registry: SecretRegistry, env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (isForeverDeniedSecret(name) || !NAME.test(name)) return undefined;
  const entry = registry.get(name);
  if (!entry || entry.kind === "console") return undefined;
  if (entry.kind === "file") {
    try {
      return readFileSync(entry.source, "utf8").replace(/\r?\n$/, "");
    } catch {
      return undefined;
    }
  }
  const fileKey = `${name}_FILE`;
  const plain = env[name];
  const filePath = env[fileKey];
  if (plain && filePath) return undefined;
  if (filePath) {
    try {
      return readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
    } catch {
      return undefined;
    }
  }
  return plain || undefined;
}

function hasSideEffect(grants: FunctionGrants): boolean {
  return (
    (grants.files ?? []).some((grant) => grant.access === "write") ||
    (grants.apis ?? []).some((grant) => grant.access === "action")
  );
}

function failure(code: string, message: string): FunctionInvokeResult {
  return { ok: false, code, message, logs: "", logsTruncated: false };
}

function cancelled(): { ok: false; code: string; message: string } {
  return { ok: false, code: "cancelled", message: "function execution cancelled" };
}

function uncertain(): { ok: false; code: string; message: string } {
  return { ok: false, code: "uncertain_outcome", message: "function write outcome is uncertain" };
}

function capabilityResult(
  requestId: string,
  result: { ok: true; value: import("./protocol.js").JsonValue } | { ok: false; code: string; message: string },
): FunctionCapabilityResult {
  if (result.ok) return { type: "capability_result", requestId, ok: true, value: result.value };
  return { type: "capability_result", requestId, ok: false, code: result.code, message: result.message };
}
