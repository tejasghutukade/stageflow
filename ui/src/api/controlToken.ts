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

/** Exchange `#code=` for the control token, then drop the fragment. A failed exchange leaves a stored token in place. */
export function captureControlTokenFragment(): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  if (!hash.startsWith("#code=")) return;
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
  void fetch("/api/console-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
    .then(async (res) => {
      if (!res.ok) {
        if (previous.length > 0) setControlToken(previous);
        return;
      }
      const body = (await res.json()) as { token?: unknown };
      if (typeof body.token === "string" && body.token.length > 0) setControlToken(body.token);
    })
    .catch(() => {
      if (previous.length > 0) setControlToken(previous);
    });
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

captureControlTokenFragment();
