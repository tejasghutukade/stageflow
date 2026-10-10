import {
  writeThemePreference,
  type ThemeMode,
} from "../themePreference";

export type SettingsAppearanceProps = {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  redesignOn: boolean;
  onRedesignChange: (on: boolean) => void;
  variant?: "legacy" | "redesign";
};

export function SettingsAppearance({
  value,
  onChange,
  redesignOn,
  onRedesignChange,
  variant = "legacy",
}: SettingsAppearanceProps) {
  if (variant === "redesign") {
    return (
      <>
        <p className="font-sans text-[13px] text-[var(--sf-text-2)]">
          Applies immediately, on every screen.
        </p>
        <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Color theme">
          {(["system", "light", "dark"] as const).map((t) => {
            const selected = value === t;
            const label =
              t === "system" ? "System" : t === "light" ? "Light" : "Dark";
            return (
              <button
                key={t}
                type="button"
                aria-pressed={selected}
                className={`flex min-w-[120px] flex-col gap-2 rounded-[10px] border p-3 text-left${
                  selected
                    ? " border-[#ffffff47] bg-[var(--sf-active)] shadow-[0px_0px_0px_3px_rgba(255,255,255,0.04)]"
                    : " border-[#ffffff12] bg-[var(--sf-raised)]"
                }`}
                onClick={() => {
                  writeThemePreference(t);
                  onChange(t);
                }}
              >
                <span
                  className={`h-8 w-full rounded-md border border-[#ffffff1a]${
                    t === "light"
                      ? " bg-[#e8e9eb]"
                      : t === "dark"
                        ? " bg-[#1a1c21]"
                        : " bg-gradient-to-r from-[#e8e9eb] to-[#1a1c21]"
                  }`}
                />
                <span className="font-sans text-sm font-medium text-[var(--sf-text-1)]">
                  {label}
                </span>
                <span className="font-sans text-xs text-[var(--sf-text-3)]">
                  {t === "system" ? "Follows this machine" : "Astryx neutral"}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-t-[#ffffff12] pt-4">
          <span className="min-w-0 flex-1">
            <span className="block font-sans text-[13px] font-medium text-[var(--sf-text-1)]">
              Signal box redesign (preview)
            </span>
            <span className="mt-0.5 block font-sans text-xs text-[var(--sf-text-3)]">
              Signal box dark palette. Redesign preview uses the Signal box dark
              palette regardless of theme above.
            </span>
          </span>
          <button
            type="button"
            className={`flex h-8 shrink-0 items-center rounded-lg border px-3 font-sans text-[13px] font-medium${
              redesignOn
                ? " border-[#ffffff47] bg-[var(--sf-text-1)] text-[var(--sf-ground)]"
                : " border-[#ffffff1a] bg-[var(--sf-raised)] text-[var(--sf-text-1)]"
            }`}
            aria-pressed={redesignOn}
            onClick={() => onRedesignChange(!redesignOn)}
          >
            {redesignOn ? "On" : "Off"}
          </button>
        </div>
      </>
    );
  }

  return (
    <section className="card">
      <div className="card__head"><h2>Appearance</h2></div>
      <p style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "var(--font-size-sm)" }}>Applies immediately, on every screen.</p>
      <div className="theme-picks" role="radiogroup" aria-label="Color theme">
        {(["system", "light", "dark"] as const).map(t => (
          <button
            key={t}
            type="button"
            className="theme-pick"
            data-theme={t}
            aria-pressed={value === t ? "true" : "false"}
            onClick={() => { writeThemePreference(t); onChange(t); }}
          >
            <span className="theme-pick__swatch" data-preview={t}></span>
            <strong>{t === "system" ? "System" : t === "light" ? "Light" : "Dark"}</strong>
            <span>{t === "system" ? "Follows this machine" : "Astryx neutral"}</span>
          </button>
        ))}
      </div>
      <div className="setting" style={{ marginTop: "var(--spacing-4)" }}>
        <span>
          <strong>Signal box redesign (preview)</strong>
          <p style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "var(--font-size-sm)" }}>
            Signal box dark palette. Redesign preview uses the Signal box dark palette regardless of theme above.
          </p>
        </span>
        <button
          type="button"
          className="btn"
          aria-pressed={redesignOn ? "true" : "false"}
          onClick={() => onRedesignChange(!redesignOn)}
        >
          {redesignOn ? "On" : "Off"}
        </button>
      </div>
    </section>
  );
}
