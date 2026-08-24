export type ThemeMode = "system" | "light" | "dark";

const KEY = "sf-theme";

export function readThemePreference(): ThemeMode {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* empty */
  }
  return "system";
}

export function writeThemePreference(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* empty */
  }
}
