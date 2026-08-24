import type {
  LoginSessionEvent,
  LoginSessionPendingPrompt,
  LoginSessionProjection,
} from "../api";

export const OAUTH_LOOPBACK_CAVEAT =
  "Pi may complete login via a local callback in the Stageflow process. If the browser cannot reach this machine, paste the redirect URL or code when prompted.";

export const OAUTH_PASTE_HINT =
  "If automatic completion does not finish, paste the redirect URL or manual code below.";

export function latestAuthUrl(
  events: readonly LoginSessionEvent[],
): Extract<LoginSessionEvent, { type: "auth_url" }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "auth_url") return event;
  }
  return undefined;
}

export function latestDeviceCode(
  events: readonly LoginSessionEvent[],
): Extract<LoginSessionEvent, { type: "device_code" }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "device_code") return event;
  }
  return undefined;
}

export function latestStatusMessage(
  events: readonly LoginSessionEvent[],
): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "progress" || event?.type === "info") {
      return event.message;
    }
  }
  return undefined;
}

export function latestInfoLinks(
  events: readonly LoginSessionEvent[],
): readonly { url: string; label?: string }[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "info" && event.links && event.links.length > 0) {
      return event.links;
    }
  }
  return undefined;
}

export function isTerminalSession(
  session: Pick<LoginSessionProjection, "status">,
): boolean {
  return (
    session.status === "completed" ||
    session.status === "failed" ||
    session.status === "cancelled"
  );
}

export function promptInputKind(
  prompt: LoginSessionPendingPrompt,
): "text" | "password" | "select" {
  if (prompt.type === "select") return "select";
  if (prompt.type === "secret") return "password";
  return "text";
}

export function providerSupportsOauthConnect(provider: {
  supportsOauth: boolean;
}): boolean {
  return provider.supportsOauth;
}
