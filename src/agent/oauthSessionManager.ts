import { randomUUID } from "node:crypto";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import {
  defaultContext,
  openRuntime,
  statusForProvider,
  ProviderAuthError,
  type ProviderAuthContext,
  type ProviderAuthStatus,
} from "./providerAuth.js";

export type LoginSessionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type LoginSessionPendingPrompt = {
  type: AuthPrompt["type"];
  message: string;
  placeholder?: string;
  options?: readonly {
    id: string;
    label: string;
    description?: string;
  }[];
};

export type LoginSessionProjection = {
  id: string;
  providerId: string;
  authType: "oauth";
  status: LoginSessionStatus;
  events: AuthEvent[];
  hosted: boolean;
  pendingPrompt?: LoginSessionPendingPrompt;
  error?: { message: string };
  warning?: { message: string };
  provider?: ProviderAuthStatus;
};

export type OAuthLoginOptions = {
  hosted?: boolean;
};

export const DEVICE_CODE_UNAVAILABLE_MESSAGE =
  "Device code login is not available. Continue with browser login.";

type HostedLoginMode = "auto-device" | "browser-fallback" | "ask";

type PendingPromptWait = {
  meta: LoginSessionPendingPrompt;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
};

type InternalLoginSession = {
  id: string;
  providerId: string;
  authType: "oauth";
  status: LoginSessionStatus;
  hosted: boolean;
  events: AuthEvent[];
  pendingPrompt?: PendingPromptWait;
  error?: { message: string };
  warning?: { message: string };
  provider?: ProviderAuthStatus;
  abortController: AbortController;
};

const loginSessions = new Map<string, InternalLoginSession>();
let runningLoginSessionId: string | undefined;

function automaticSelectAnswer(
  prompt: AuthPrompt,
  mode: HostedLoginMode,
): string | undefined {
  if (mode === "ask" || prompt.type !== "select") return undefined;
  const ids = prompt.options.map((option) => option.id);
  if (!ids.includes("device_code")) return undefined;
  if (mode === "auto-device") return "device_code";
  return ids.includes("browser") ? "browser" : undefined;
}

function deviceCodeUnavailable(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes("not enabled for this server")
  );
}

function promptMeta(prompt: AuthPrompt): LoginSessionPendingPrompt {
  if (prompt.type === "select") {
    return {
      type: "select",
      message: prompt.message,
      options: prompt.options.map((o) => ({
        id: o.id,
        label: o.label,
        ...(o.description !== undefined ? { description: o.description } : {}),
      })),
    };
  }
  return {
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder !== undefined
      ? { placeholder: prompt.placeholder }
      : {}),
  };
}

function projectLoginSession(
  session: InternalLoginSession,
): LoginSessionProjection {
  return {
    id: session.id,
    providerId: session.providerId,
    authType: "oauth",
    status: session.status,
    hosted: session.hosted,
    events: [...session.events],
    ...(session.pendingPrompt
      ? { pendingPrompt: session.pendingPrompt.meta }
      : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.warning ? { warning: session.warning } : {}),
    ...(session.provider ? { provider: session.provider } : {}),
  };
}

function rejectPendingPrompt(
  session: InternalLoginSession,
  reason: Error,
): void {
  const pending = session.pendingPrompt;
  if (!pending) return;
  session.pendingPrompt = undefined;
  pending.reject(reason);
}

function clearRunningIf(sessionId: string): void {
  if (runningLoginSessionId === sessionId) {
    runningLoginSessionId = undefined;
  }
}

export function getLoginSession(
  sessionId: string,
): LoginSessionProjection | undefined {
  const session = loginSessions.get(sessionId);
  return session ? projectLoginSession(session) : undefined;
}

export function answerLoginSession(
  sessionId: string,
  value: string,
): LoginSessionProjection {
  const session = loginSessions.get(sessionId);
  if (!session) {
    throw new ProviderAuthError("Login session not found", 404);
  }
  if (session.status !== "running") {
    throw new ProviderAuthError("Login session is not awaiting input", 409);
  }
  if (!session.pendingPrompt) {
    throw new ProviderAuthError("No pending login prompt", 409);
  }
  if (typeof value !== "string") {
    throw new ProviderAuthError("value is required", 400);
  }
  const pending = session.pendingPrompt;
  session.pendingPrompt = undefined;
  pending.resolve(value);
  return projectLoginSession(session);
}

export function cancelLoginSession(
  sessionId: string,
): LoginSessionProjection {
  const session = loginSessions.get(sessionId);
  if (!session) {
    throw new ProviderAuthError("Login session not found", 404);
  }
  if (session.status !== "running") {
    return projectLoginSession(session);
  }
  session.status = "cancelled";
  session.error = { message: "Login cancelled" };
  clearRunningIf(sessionId);
  rejectPendingPrompt(session, new Error("Login cancelled"));
  session.abortController.abort();
  return projectLoginSession(session);
}

export function resetSessionsForTests(): void {
  for (const session of loginSessions.values()) {
    if (session.status === "running") {
      session.status = "cancelled";
      rejectPendingPrompt(session, new Error("Login cancelled"));
      session.abortController.abort();
    }
  }
  loginSessions.clear();
  runningLoginSessionId = undefined;
}

export async function startOAuthLoginSession(
  cwd: string,
  providerId: string,
  ctx: ProviderAuthContext = defaultContext,
  options?: OAuthLoginOptions,
): Promise<LoginSessionProjection> {
  if (runningLoginSessionId !== undefined) {
    throw new ProviderAuthError("An OAuth login is already in progress", 409);
  }

  const runtime = await openRuntime(cwd, ctx);
  const provider = runtime.getProvider(providerId);
  if (!provider) {
    throw new ProviderAuthError("Provider not found", 404);
  }
  if (provider.auth.oauth === undefined) {
    throw new ProviderAuthError("Provider does not support oauth login", 400);
  }

  const sessionId = randomUUID();
  const abortController = new AbortController();
  const hosted = options?.hosted === true;
  let loginMode: HostedLoginMode = hosted ? "auto-device" : "ask";
  const session: InternalLoginSession = {
    id: sessionId,
    providerId,
    authType: "oauth",
    status: "running",
    hosted,
    events: [],
    abortController,
  };
  loginSessions.set(sessionId, session);
  runningLoginSessionId = sessionId;

  const interaction = {
    signal: abortController.signal,
    notify(event: AuthEvent): void {
      if (session.status !== "running") return;
      session.events.push(event);
    },
    prompt(prompt: AuthPrompt): Promise<string> {
      if (session.status !== "running") {
        return Promise.reject(new Error("Login session is not running"));
      }
      if (abortController.signal.aborted || prompt.signal?.aborted) {
        return Promise.reject(new Error("Login cancelled"));
      }
      const automatic = automaticSelectAnswer(prompt, loginMode);
      if (automatic !== undefined) {
        return Promise.resolve(automatic);
      }
      return new Promise<string>((resolve, reject) => {
        const onAbort = () => {
          if (session.pendingPrompt) {
            session.pendingPrompt = undefined;
            reject(new Error("Login cancelled"));
          }
        };
        abortController.signal.addEventListener("abort", onAbort, {
          once: true,
        });
        if (prompt.signal) {
          prompt.signal.addEventListener("abort", onAbort, { once: true });
        }
        session.pendingPrompt = {
          meta: promptMeta(prompt),
          resolve: (value) => {
            abortController.signal.removeEventListener("abort", onAbort);
            prompt.signal?.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (err) => {
            abortController.signal.removeEventListener("abort", onAbort);
            prompt.signal?.removeEventListener("abort", onAbort);
            reject(err);
          },
        };
      });
    },
  };

  void (async () => {
    try {
      try {
        await runtime.login(providerId, "oauth", interaction);
      } catch (err) {
        if (
          loginMode === "auto-device" &&
          session.status === "running" &&
          !abortController.signal.aborted &&
          deviceCodeUnavailable(err)
        ) {
          loginMode = "browser-fallback";
          session.events.push({
            type: "info",
            message: DEVICE_CODE_UNAVAILABLE_MESSAGE,
          });
          await runtime.login(providerId, "oauth", interaction);
        } else {
          throw err;
        }
      }
      if (session.status !== "running") return;
      session.status = "completed";
      session.provider = await statusForProvider(runtime, providerId);
    } catch (err) {
      if (session.status === "cancelled") {
        return;
      }
      if (err instanceof CredentialSynchronizationError) {
        session.status = "completed";
        session.warning = {
          message:
            "Connected, but model catalog sync failed. Credentials were saved — you can retry later without disconnecting.",
        };
        try {
          session.provider = await statusForProvider(runtime, providerId);
        } catch {
          session.provider = {
            providerId,
            configured: true,
            authKind: "oauth",
          };
        }
        return;
      }
      if (abortController.signal.aborted) {
        session.status = "cancelled";
        session.error = { message: "Login cancelled" };
        return;
      }
      session.status = "failed";
      session.error = { message: "Provider login failed" };
    } finally {
      if (session.pendingPrompt) {
        rejectPendingPrompt(session, new Error("Login finished"));
      }
      clearRunningIf(sessionId);
    }
  })();

  return projectLoginSession(session);
}
