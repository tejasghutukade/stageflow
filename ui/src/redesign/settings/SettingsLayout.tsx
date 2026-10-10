import type { ReactNode } from "react";
import { Keycap } from "../Keycap";
import { SettingsNav, type SettingsSection, sectionLabel } from "./SettingsNav";
import { LuCheck, LuChevronRight, LuSettings } from "react-icons/lu";

export type SettingsLayoutProps = {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  providersNavCount?: string;
  children: ReactNode;
};

export function SettingsLayout({
  section,
  onSectionChange,
  providersNavCount,
  children,
}: SettingsLayoutProps) {
  const crumb = sectionLabel(section);

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      <div className="flex h-[52px] w-full shrink-0 items-center justify-between border-b border-b-[#ffffff12] px-6 py-0">
        <div className="flex items-center gap-1.5">
          <LuSettings className="size-3.5 text-[var(--sf-text-3)]" aria-hidden="true" />
          <span className="font-sans text-[13px] text-[var(--sf-text-3)]">Settings</span>
          <LuChevronRight className="size-3.5 text-[var(--sf-text-3)]" aria-hidden="true" />
          <span className="font-sans text-[13px] font-medium text-[var(--sf-text-1)]">
            {crumb}
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <LuCheck className="size-3.5 text-[var(--sf-ok)]" aria-hidden="true" />
          <span className="font-sans text-xs text-[var(--sf-text-2)]">Saved to</span>
          <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
            ~/.stageflow/config.yaml
          </span>
          <Keycap className="text-[var(--sf-text-3)]">⌘,</Keycap>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <SettingsNav
          active={section}
          onSelect={onSectionChange}
          providersConnected={providersNavCount}
        />
        <div
          id="sf-settings-scroll"
          className="mr-auto flex min-h-0 w-full max-w-[840px] shrink-0 flex-col gap-6 overflow-y-auto px-10 pb-10 pt-7"
        >
          {children}
        </div>
      </div>
    </div>
  );
}
