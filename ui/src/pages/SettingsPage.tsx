import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsLayout } from "../redesign/settings/SettingsLayout";
import {
  parseSettingsSection,
  SETTINGS_SECTIONS,
  settingsPath,
  settingsSectionDomId,
  type SettingsSection,
} from "../redesign/settings/SettingsNav";
import { SettingsProvidersPanel } from "../redesign/settings/SettingsProvidersPanel";
import { SettingsProjectMcpPanel } from "../redesign/settings/SettingsProjectMcpPanel";
import {
  SettingsConcurrencyPanel,
  SettingsGeneralPanel,
  SettingsMcpPanel,
  SettingsNotificationsPanel,
} from "../redesign/settings/SettingsSectionPanels";
import { navigate } from "../routes";
import {
  fetchSettings,
  postSettings,
  postWorkshopModel,
} from "../api";
import {
  useRunCatalog,
  useRunCatalogHandle,
} from "../catalog/useRunCatalog";
import {
  notificationPermission,
  requestNotificationPermission,
  writeNotifyPreference,
  type NotifyPreference,
} from "../useWaitingNotifications";


function scrollSettingsSectionIntoView(
  section: SettingsSection,
  behavior: ScrollBehavior = "smooth",
) {
  const root = document.getElementById("sf-settings-scroll");
  const el = document.getElementById(settingsSectionDomId(section));
  if (!root || !el) return;
  const rootRect = root.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const delta = elRect.top - rootRect.top;
  root.scrollTo({ top: root.scrollTop + delta, behavior });
}

function replaceSettingsHash(section: SettingsSection) {
  const next = `#${settingsPath(section)}`;
  if (window.location.hash !== next) {
    history.replaceState(null, "", next);
  }
}

function formatDiskBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function SettingsPage({
  notifyPreference,
  onNotifyChange,
}: {
  notifyPreference: NotifyPreference;
  onNotifyChange: (value: NotifyPreference) => void;
}) {
  const { snapshot } = useRunCatalog();
  const catalog = useRunCatalogHandle();
  const health = snapshot.health;
  const healthEverLoadedRef = useRef(false);
  if (health) healthEverLoadedRef.current = true;
  const healthEverLoaded = healthEverLoadedRef.current;
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [slotsSaving, setSlotsSaving] = useState(false);
  const [permission, setPermission] = useState(notificationPermission);
  const [workshopModel, setWorkshopModel] = useState<string>("");
  const [workshopModelError, setWorkshopModelError] = useState<string | null>(
    null,
  );
  const [workshopModelSaving, setWorkshopModelSaving] = useState(false);
  const [section, setSection] = useState<SettingsSection>(() =>
    parseSettingsSection(),
  );
  const [providersNavCount, setProvidersNavCount] = useState<string | undefined>(
    undefined,
  );
  const programmaticScrollRef = useRef(false);
  const initialScrollDoneRef = useRef(false);

  useEffect(() => {
    const onHash = () => {
      const next = parseSettingsSection();
      setSection(next);
      if (!programmaticScrollRef.current) {
        scrollSettingsSectionIntoView(next, "auto");
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (initialScrollDoneRef.current) return;
    initialScrollDoneRef.current = true;
    requestAnimationFrame(() => {
      scrollSettingsSectionIntoView(parseSettingsSection(), "auto");
    });
  }, []);

  useEffect(() => {
    const root = document.getElementById("sf-settings-scroll");
    if (!root) return;

    const observed = SETTINGS_SECTIONS.map(({ id }) =>
      document.getElementById(settingsSectionDomId(id)),
    ).filter((el): el is HTMLElement => el != null);

    const syncActiveSection = () => {
      if (programmaticScrollRef.current) return;
      const rootTop = root.getBoundingClientRect().top;
      const positions = SETTINGS_SECTIONS.flatMap(({ id }) => {
        const el = document.getElementById(settingsSectionDomId(id));
        if (!el) return [];
        const top =
          el.getBoundingClientRect().top - rootTop + root.scrollTop;
        return [{ id, top }];
      });
      const visible = positions.filter((p) => p.top <= root.scrollTop + 32);
      const last = visible[visible.length - 1];
      if (!last) return;
      const sameRow = visible.filter((p) => Math.abs(p.top - last.top) < 8);
      setSection((prev) => {
        const active = sameRow.some((p) => p.id === prev)
          ? prev
          : sameRow[0].id;
        if (prev === active) return prev;
        replaceSettingsHash(active);
        return active;
      });
    };

    const observer = new IntersectionObserver(
      () => syncActiveSection(),
      { root, threshold: [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1] },
    );

    for (const el of observed) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await fetchSettings();
        if (cancelled) return;
        setWorkshopModel(settings.workshopModel ?? "");
      } catch (err) {
        if (cancelled) return;
        setWorkshopModelError(
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onNotifySelect(value: string) {
    const next: NotifyPreference = value === "system" ? "system" : "off";
    writeNotifyPreference(next);
    onNotifyChange(next);
    if (next === "system" && notificationPermission() === "default") {
      const result = await requestNotificationPermission();
      setPermission(result);
    }
  }

  async function onSlotsChange(value: number) {
    setSlotsSaving(true);
    setSlotsError(null);
    try {
      await postSettings(value);
      await catalog.refresh();
    } catch (err) {
      setSlotsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSlotsSaving(false);
    }
  }

  async function onWorkshopModelChange(value: string) {
    setWorkshopModelSaving(true);
    setWorkshopModelError(null);
    try {
      const next = value.trim();
      if (!next) return;
      const result = await postWorkshopModel(next);
      setWorkshopModel(result.workshopModel ?? next);
    } catch (err) {
      setWorkshopModelError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkshopModelSaving(false);
    }
  }

  const onProvidersSummary = useCallback((connected: number, total: number) => {
    setProvidersNavCount(total > 0 ? `${connected}/${total}` : undefined);
  }, []);

  function onSectionChange(next: SettingsSection) {
    programmaticScrollRef.current = true;
    window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 450);
    navigate(settingsPath(next));
    setSection(next);
    requestAnimationFrame(() => {
      scrollSettingsSectionIntoView(next, "smooth");
    });
  }

  return (
    <SettingsLayout
      section={section}
      onSectionChange={onSectionChange}
      providersNavCount={providersNavCount}
    >
      <section id={settingsSectionDomId("general")} className="scroll-mt-1">
        <SettingsGeneralPanel
          workshopModel={workshopModel}
          workshopModelSaving={workshopModelSaving}
          workshopModelError={workshopModelError}
          onWorkshopModelChange={(v) => void onWorkshopModelChange(v)}
          health={health}
          formatDiskBytes={formatDiskBytes}
        />
      </section>
      <section id={settingsSectionDomId("providers")} className="scroll-mt-1">
        <SettingsProvidersPanel onProvidersSummary={onProvidersSummary} />
      </section>
      <div className="grid w-full grid-cols-[1fr_1.25fr] gap-3">
        <section
          id={settingsSectionDomId("concurrency")}
          className="min-w-0 scroll-mt-1"
        >
          <SettingsConcurrencyPanel
            snapshot={snapshot}
            health={health}
            healthEverLoaded={healthEverLoaded}
            slotsSaving={slotsSaving}
            slotsError={slotsError}
            onSlotsChange={(v) => void onSlotsChange(v)}
          />
        </section>
        <section id={settingsSectionDomId("mcp")} className="min-w-0 scroll-mt-1">
          <SettingsMcpPanel />
        </section>
      </div>
      <section id={settingsSectionDomId("project-mcp")} className="scroll-mt-1">
        <SettingsProjectMcpPanel />
      </section>
      <section id={settingsSectionDomId("notifications")} className="scroll-mt-1">
        <SettingsNotificationsPanel
          notifyPreference={notifyPreference}
          permission={permission}
          onNotifySelect={(v) => void onNotifySelect(v)}
        />
      </section>
      <div className="min-h-[45vh] shrink-0" aria-hidden="true" />
    </SettingsLayout>
  );
}
