const CONTROL_TOKEN_KEY = "stageflow.controlToken";

export function getControlToken(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(CONTROL_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
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
