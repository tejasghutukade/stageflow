const CONTROL_TOKEN_KEY = "stageflow.controlToken";

export const CONTROL_TOKEN_REQUIRED_EVENT = "sf-control-token-required";

let controlTokenRequired = false;
const controlTokenRequiredListeners = new Set<() => void>();

export function wasControlTokenRequired(): boolean {
  return controlTokenRequired;
}

export function subscribeControlTokenRequired(listener: () => void): () => void {
  controlTokenRequiredListeners.add(listener);
  return () => controlTokenRequiredListeners.delete(listener);
}

export function notifyControlTokenRequired(): void {
  controlTokenRequired = true;
  for (const listener of controlTokenRequiredListeners) listener();
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CONTROL_TOKEN_REQUIRED_EVENT));
}

export function getControlToken(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(CONTROL_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

const CODE_EXCHANGE_TIMEOUT_MS = 5_000;

/**
 * Exchange `#code=` for the control token, then drop the fragment. A failed exchange leaves a stored token in
 * place. Resolves when the exchange settles, so the app can wait before its first API call.
 */
export function captureControlTokenFragment(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const hash = window.location.hash;
  if (!hash.startsWith("#code=")) return Promise.resolve();
  const raw = hash.slice("#code=".length);
  let code = raw;
  try {
    code = decodeURIComponent(raw);
  } catch {
    code = raw;
  }
  const next = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, "", next);
  const previous = getControlToken();
  const restore = () => {
    if (previous.length > 0) setControlToken(previous);
  };
  const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
  const timer = setTimeout(() => controller?.abort(), CODE_EXCHANGE_TIMEOUT_MS);
  return fetch("/api/console-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
    signal: controller?.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        restore();
        return;
      }
      const body = (await res.json()) as { token?: unknown };
      if (typeof body.token === "string" && body.token.length > 0) {
        setControlToken(body.token);
        controlTokenRequired = false;
      } else {
        restore();
      }
    })
    .catch(restore)
    .finally(() => clearTimeout(timer));
}

export function setControlToken(token: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      localStorage.removeItem(CONTROL_TOKEN_KEY);
    } else {
      localStorage.setItem(CONTROL_TOKEN_KEY, trimmed);
    }
  } catch {
    // ignore quota / private mode
  }
}

export function authorizationHeaders(): Record<string, string> {
  const token = getControlToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/** Settles once a `#code=` login link has been exchanged (or immediately when there is none). */
export const controlTokenReady: Promise<void> = captureControlTokenFragment();
