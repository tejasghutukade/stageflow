import { AsyncLocalStorage } from "node:async_hooks";
import type { BearerAuth, ControlScope } from "./controlToken.js";

export type CallerSurface = "mcp" | "rest" | "cli" | "a2a";

export type RequestAuthContext = {
  scope: ControlScope;
  caller_id: string;
  surface: CallerSurface;
};

const storage = new AsyncLocalStorage<RequestAuthContext | null>();

export function runWithRequestAuth<T>(
  auth: RequestAuthContext | null,
  fn: () => T,
): T {
  return storage.run(auth, fn);
}

export function getRequestAuth(): RequestAuthContext | null {
  return storage.getStore() ?? null;
}

export function requestAuthFromBearer(
  bearer: BearerAuth | undefined,
  surface: CallerSurface,
): RequestAuthContext | null {
  if (bearer === undefined) return null;
  return {
    scope: bearer.scope,
    caller_id: bearer.caller_id,
    surface,
  };
}

/** Attribution for createRun: auth caller only; CLI / open loopback → null. */
export function callerIdFromRequestAuth(): string | null {
  return getRequestAuth()?.caller_id ?? null;
}
