import {
  writeThemePreference,
  type ThemeMode,
} from "../themePreference";

export type SettingsAppearanceProps = {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
};

export function SettingsAppearance({
  value,
  onChange,
}: SettingsAppearanceProps) {
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
    </section>
  );
}
