import { useState } from "react";
import { postSettings } from "../api";
import {
  useRunCatalog,
  useRunCatalogHandle,
} from "../catalog/useRunCatalog";
import type { ThemeMode } from "../themePreference";
import { SettingsAppearance } from "../components/SettingsAppearance";
import { SettingsMcp } from "../components/SettingsMcp";
import { SettingsProviders } from "../components/SettingsProviders";
import {
  notificationPermission,
  requestNotificationPermission,
  writeNotifyPreference,
  type NotifyPreference,
} from "../useWaitingNotifications";

export function SettingsPage({
  themeMode,
  onThemeChange,
  notifyPreference,
  onNotifyChange,
}: {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  notifyPreference: NotifyPreference;
  onNotifyChange: (value: NotifyPreference) => void;
}) {
  const { snapshot, loading } = useRunCatalog();
  const catalog = useRunCatalogHandle();
  const health = snapshot.health;
  const healthLoading = loading && health == null;
  const healthError =
    !healthLoading && health == null ? "unavailable" : null;
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [slotsSaving, setSlotsSaving] = useState(false);
  const [permission, setPermission] = useState(notificationPermission);

  async function onNotifySelect(value: string) {
    const next: NotifyPreference = value === "system" ? "system" : "off";
    writeNotifyPreference(next);
    onNotifyChange(next);
    if (next === "system" && notificationPermission() === "default") {
      const result = await requestNotificationPermission();
      setPermission(result);
    }
  }

  async function onSlotsChange(value: string) {
    const n = Number(value);
    setSlotsSaving(true);
    setSlotsError(null);
    try {
      await postSettings(n);
      await catalog.refresh();
    } catch (err) {
      setSlotsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSlotsSaving(false);
    }
  }

  const SLOT_CHOICES = [1, 2, 3, 4, 6];
  const currentSlots = health?.maxConcurrent;
  const slotOptions =
    currentSlots != null && !SLOT_CHOICES.includes(currentSlots)
      ? [currentSlots, ...SLOT_CHOICES]
      : SLOT_CHOICES;

  return (
    <div className="main__inner">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Local to this machine. Nothing here is shared, because Stageflow runs as one operator's CLI.</p>
        </div>
      </div>

      <SettingsAppearance value={themeMode} onChange={onThemeChange} />

      <SettingsProviders />

      <SettingsMcp />

      <section className="card">
        <div className="card__head"><h2>Concurrency</h2></div>
        {healthError ? <p style={{ color: "var(--color-text-red)", fontSize: "var(--font-size-sm)", marginBottom: "var(--spacing-3)" }}>Could not load capacity: {healthError}</p> : null}
        <div className="setting">
          <span>
            <strong>Session slots</strong>
            <p>How many stage sessions may be alive at once. A stage waiting on you still holds its slot. Lowering the cap does not stop runs that are already in flight.</p>
          </span>
          {healthLoading ? (
            <span className="muted">—</span>
          ) : health ? (
            <select
              className="select"
              value={health.maxConcurrent}
              disabled={slotsSaving}
              onChange={(e) => void onSlotsChange(e.target.value)}
            >
              {slotOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                  {n === health.maxConcurrent ? " · current" : ""}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted">—</span>
          )}
        </div>
        {slotsError ? (
          <p style={{ color: "var(--color-text-red)", fontSize: "var(--font-size-sm)", marginBottom: "var(--spacing-3)" }}>
            Could not update slots: {slotsError}
          </p>
        ) : null}
        <div className="setting">
          <span>
            <strong>Slots available</strong>
            <p>Free slots that can accept a new run right now.</p>
          </span>
          <span className="muted">{healthLoading ? "—" : health ? String(health.slotsAvailable) : "—"}</span>
        </div>
        <div className="setting">
          <span>
            <strong>When slots are full</strong>
            <p>Reject with busy_capacity. There is no queue.</p>
          </span>
          <span className="muted">Reject with busy_capacity</span>
        </div>
      </section>

      <section className="card">
        <div className="card__head"><h2>Held stages</h2></div>
        <div className="setting">
          <span>
            <strong>Hold timeout</strong>
            <p>A held stage waits until you answer. There is no timeout yet.</p>
          </span>
          <span className="muted">—</span>
        </div>
        <div className="setting">
          <span>
            <strong>Notify me when a stage asks</strong>
            <p>A held stage is invisible if this window is closed. A system notification is the only thing that reaches you.</p>
          </span>
          <select className="select" value={notifyPreference} onChange={e => void onNotifySelect(e.target.value)}>
            <option value="system">System notification</option>
            <option value="off">Nothing</option>
          </select>
        </div>
        {notifyPreference === "system" && permission === "denied" ? (
          <p className="muted" style={{ fontSize: "var(--font-size-xs)", padding: "var(--spacing-2) 0" }}>Notifications blocked — enable in browser settings</p>
        ) : null}
      </section>
    </div>
  );
}
