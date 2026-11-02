import type {
  LoginSessionEvent,
  LoginSessionPendingPrompt,
  LoginSessionProjection,
} from "../api";

export const OAUTH_LOOPBACK_CAVEAT =
  "Pi may complete login via a local callback in the Stageflow process. If the browser cannot reach this machine, paste the redirect URL or code when prompted.";

export const OAUTH_PASTE_HINT =
  "If automatic completion does not finish, paste the redirect URL or manual code below.";

export const OAUTH_HOSTED_PASTE_INSTRUCTIONS =
  "Your browser will say it cannot reach localhost. That is expected. Copy the full address from the address bar and paste it here.";

export const OAUTH_HOSTED_API_KEY_HINT =
  "An API key can be added instead in Settings, Providers.";

export function manualCodeHint(hosted: boolean | undefined): string {
  return hosted ? OAUTH_HOSTED_PASTE_INSTRUCTIONS : OAUTH_PASTE_HINT;
}

export function apiKeyHint(
  hosted: boolean | undefined,
  supportsApiKey: boolean | undefined,
): string | undefined {
  return hosted && supportsApiKey ? OAUTH_HOSTED_API_KEY_HINT : undefined;
}

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
