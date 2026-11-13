import type * as childProcess from "node:child_process";
import { FunctionExecutor } from "./executor.js";
import type { FunctionCapabilityRequest, FunctionCapabilityResult } from "./protocol.js";

export type HostFunctionCall = {
  answer(
    invocationId: string,
    request: FunctionCapabilityRequest,
    signal: AbortSignal,
  ): Promise<FunctionCapabilityResult>;
  sideEffect(invocationId: string, request: FunctionCapabilityRequest): boolean;
};

const owners = new Map<string, HostFunctionCall>();
let executor: FunctionExecutor | undefined;

export function isHostFunctionExecutor(candidate: FunctionExecutor): boolean {
  return executor !== undefined && candidate === executor;
}

function hostExecutorOptions(forkFn?: typeof childProcess.fork): ConstructorParameters<typeof FunctionExecutor>[0] {
  return {
    ...(forkFn ? { forkFn } : {}),
    onCapability: (invocationId, request, signal) => {
      const owner = owners.get(invocationId);
      if (!owner) {
        return Promise.resolve({
          type: "capability_result",
          requestId: request.requestId,
          ok: false,
          code: "exception",
          message: "function capability has no owner",
        });
      }
      return owner.answer(invocationId, request, signal);
    },
    sideEffect: (invocationId, request) => owners.get(invocationId)?.sideEffect(invocationId, request) ?? false,
  };
}

export function hostFunctionExecutor(): FunctionExecutor {
  if (!executor) executor = new FunctionExecutor(hostExecutorOptions());
  return executor;
}

export function setHostFunctionForkForTests(forkFn: typeof childProcess.fork | undefined): void {
  executor = forkFn ? new FunctionExecutor(hostExecutorOptions(forkFn)) : undefined;
  if (forkFn === undefined) owners.clear();
}

export function bindHostFunctionCall(invocationId: string, call: HostFunctionCall): void {
  owners.set(invocationId, call);
}

export function unbindHostFunctionCall(invocationId: string): void {
  owners.delete(invocationId);
}

export function setHostFunctionExecutorForTests(next: FunctionExecutor | undefined): void {
  executor = next;
  if (next === undefined) owners.clear();
}
