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
  pendingPrompt?: LoginSessionPendingPrompt;
  error?: { message: string };
  warning?: { message: string };
  provider?: ProviderAuthStatus;
};

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
  events: AuthEvent[];
  pendingPrompt?: PendingPromptWait;
  error?: { message: string };
  warning?: { message: string };
  provider?: ProviderAuthStatus;
  abortController: AbortController;
};

const loginSessions = new Map<string, InternalLoginSession>();
let runningLoginSessionId: string | undefined;

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
  const session: InternalLoginSession = {
    id: sessionId,
    providerId,
    authType: "oauth",
    status: "running",
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
      await runtime.login(providerId, "oauth", interaction);
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
