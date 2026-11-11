import { randomUUID } from "node:crypto";
import { SF_STAGE_WORKER } from "../runtime/stageWorkerProtocol.js";
import type { FunctionKind } from "../config/loadFunction.js";
import { FUNCTION_KILL_GRACE_MS, FUNCTION_TIMEOUT_MS_MAX } from "./protocol.js";
import type { FunctionCallInput, FunctionRunView } from "./invoke.js";

const HOST_TIMEOUT_MS = FUNCTION_TIMEOUT_MS_MAX + FUNCTION_KILL_GRACE_MS + 1_000;

export type StageFunctionHost = {
  call(projectRoot: string, input: FunctionCallInput): Promise<FunctionRunView>;
  cancel(invocationId: string): Promise<void>;
};

type FunctionHostTransport = {
  connected?: boolean;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message" | "disconnect", listener: (message?: unknown) => void): unknown;
  once(event: "disconnect", listener: () => void): unknown;
};

export function stageFunctionCallsUseHost(): boolean {
  return process.env[SF_STAGE_WORKER] === "1" && typeof process.send === "function";
}

export function callFunctionOnHost(
  input: FunctionCallInput,
  transport: FunctionHostTransport = process as unknown as FunctionHostTransport,
): Promise<FunctionRunView> {
  return callFunctionOnTransport(input, transport);
}

export function cancelFunctionOnHost(invocationId: string): void {
  const transport = process as unknown as FunctionHostTransport;
  if (transport.connected === false || typeof transport.send !== "function") return;
  try {
    transport.send({ type: "function.cancel", requestId: invocationId });
  } catch {
    // The host cancels outstanding calls when the worker exits.
  }
}

export function isStageFunctionMessage(
  message: unknown,
): message is { type: "function.invoke" | "function.cancel"; requestId?: unknown; input?: unknown } {
  if (!message || typeof message !== "object") return false;
  const type = (message as { type?: unknown }).type;
  return type === "function.invoke" || type === "function.cancel";
}

export async function handleStageFunctionMessage(
  message: { type?: string; requestId?: unknown; input?: unknown },
  host: StageFunctionHost,
  projectRoot: string,
  send: (message: object) => void,
  alive: () => boolean,
): Promise<void> {
  if (typeof message.requestId !== "string" || message.requestId.length === 0 || message.requestId.length > 100) return;
  if (message.type === "function.cancel") {
    await host.cancel(message.requestId);
    return;
  }
  const kind = functionKind(message.input);
  if (!kind) {
    if (alive()) send(functionResponse(message.requestId, failedView(undefined, "invalid_input", "function call was rejected")));
    return;
  }
  try {
    const view = await host.call(projectRoot, { ...kind.input, invocationId: message.requestId });
    if (alive()) send(functionResponse(message.requestId, view));
  } catch (error) {
    if (alive()) {
      send(functionResponse(
        message.requestId,
        failedView(kind.input.kind, "exception", error instanceof Error ? error.message : String(error)),
      ));
    }
  }
}

function callFunctionOnTransport(input: FunctionCallInput, transport: FunctionHostTransport): Promise<FunctionRunView> {
  return new Promise((resolve, reject) => {
    if (transport.connected === false || typeof transport.send !== "function") {
      reject(new Error("function host is unavailable"));
      return;
    }
    const requestId = randomUUID();
    let settled = false;
    const finish = (error?: Error, view?: FunctionRunView): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.off("message", receive);
      transport.off("disconnect", disconnected);
      if (error) reject(error);
      else resolve(view!);
    };
    const cancel = (): void => {
      try {
        transport.send({ type: "function.cancel", requestId });
      } catch {
        return;
      }
    };
    const disconnected = (): void => {
      cancel();
      finish(new Error("function host disconnected"));
    };
    const receive = (message: unknown): void => {
      const response = message as { type?: string; requestId?: string; view?: FunctionRunView };
      if (response?.type !== "function.response" || response.requestId !== requestId || response.view === undefined) return;
      finish(undefined, response.view);
    };
    const timer = setTimeout(() => {
      cancel();
      finish(new Error("function host timed out"));
    }, HOST_TIMEOUT_MS);
    transport.on("message", receive);
    transport.once("disconnect", disconnected);
    try {
      transport.send({ type: "function.invoke", requestId, input }, (error) => {
        if (error) disconnected();
      });
    } catch {
      disconnected();
    }
  });
}

function functionKind(
  input: unknown,
): { input: FunctionCallInput } | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const kind = (input as { kind?: unknown }).kind;
  if (kind !== "verification" && kind !== "routing" && kind !== "tool") return undefined;
  const functionId = (input as { functionId?: unknown }).functionId;
  if (typeof functionId !== "string" || functionId.length === 0) return undefined;
  return { input: input as FunctionCallInput };
}

function functionResponse(requestId: string, view: FunctionRunView): object {
  return { type: "function.response", requestId, view };
}

function failedView(kind: FunctionKind | undefined, code: string, message: string): FunctionRunView {
  return {
    ok: false,
    code,
    message,
    logs: "",
    durationMs: 0,
    sourceHash: "",
    revision: null,
    kind: kind === "routing" ? "route" : kind === "tool" ? "tool" : "verification",
    status: "failed",
  };
}
