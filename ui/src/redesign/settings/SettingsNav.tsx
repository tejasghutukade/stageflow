import {
  LuBell,
  LuBraces,
  LuGauge,
  LuPalette,
  LuPlug,
  LuServer,
  LuSlidersHorizontal,
} from "react-icons/lu";
import type { IconType } from "react-icons";

export type SettingsSection =
  | "general"
  | "providers"
  | "concurrency"
  | "mcp"
  | "project-mcp"
  | "notifications"
  | "appearance";

export const SETTINGS_SECTIONS: {
  id: SettingsSection;
  label: string;
  icon: IconType;
}[] = [
  { id: "general", label: "General", icon: LuSlidersHorizontal },
  { id: "providers", label: "Providers", icon: LuPlug },
  { id: "concurrency", label: "Concurrency", icon: LuGauge },
  { id: "mcp", label: "MCP server", icon: LuServer },
  { id: "project-mcp", label: "Project MCP", icon: LuBraces },
  { id: "notifications", label: "Notifications", icon: LuBell },
  { id: "appearance", label: "Appearance", icon: LuPalette },
];

export function sectionLabel(section: SettingsSection): string {
  return SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? "Settings";
}

export function settingsSectionDomId(section: SettingsSection): string {
  return `sf-settings-${section}`;
}

export type SettingsNavProps = {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  providersConnected?: string;
};

export function SettingsNav({
  active,
  onSelect,
  providersConnected,
}: SettingsNavProps) {
  return (
    <nav
      className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-r-[#ffffff12] px-3 py-5"
      aria-label="Settings sections"
    >
      <div className="px-2.5 pb-2 pt-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
        Settings
      </div>
      {SETTINGS_SECTIONS.map((section) => {
        const isActive = active === section.id;
        const Icon = section.icon;
        return (
          <button
            key={section.id}
            type="button"
            className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 py-0 text-left${
              isActive ? " bg-[var(--sf-active)]" : ""
            }`}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onSelect(section.id)}
          >
            <Icon
              className={`size-[15px] shrink-0${
                isActive ? " text-[var(--sf-text-1)]" : " text-[var(--sf-text-3)]"
              }`}
              aria-hidden="true"
            />
            <span
              className={`min-w-0 flex-1 truncate font-sans text-[13px]${
                isActive
                  ? " font-medium text-[var(--sf-text-1)]"
                  : " text-[var(--sf-text-2)]"
              }`}
            >
              {section.label}
            </span>
            {section.id === "providers" && providersConnected ? (
              <span className="font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
                {providersConnected}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

export function parseSettingsSection(hash = window.location.hash): SettingsSection {
  const q = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  const params = new URLSearchParams(q);
  const raw = params.get("section");
  if (
    raw === "general" ||
    raw === "providers" ||
    raw === "concurrency" ||
    raw === "mcp" ||
    raw === "project-mcp" ||
    raw === "notifications" ||
    raw === "appearance"
  ) {
    return raw;
  }
  return "general";
}

export function settingsPath(section: SettingsSection): string {
  return `/settings?section=${section}`;
}
