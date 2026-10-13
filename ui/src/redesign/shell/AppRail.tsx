import type { CapacityHealth } from "../../api";
import { Keycap } from "../Keycap";
import { NAV_GROUPS } from "./navConfig";
import {
  capacityHintLine,
  capacitySlotClass,
  capacitySlotKinds,
} from "./capacitySlots";
import { usePinnedPipelines } from "./usePinnedPipelines";
import { useProviderSummary } from "./useProviderSummary";
import {
  LuChevronsUpDown,
  LuPlug,
  LuPlus,
  LuSearch,
  LuSettings,
} from "react-icons/lu";

export type AppRailProps = {
  activeId: string;
  onNavigate: (id: string) => void;
  waitingCount?: number;
  inFlightCount?: number;
  health?: CapacityHealth | null;
  workspaceName: string;
  workspaceSubtitle?: string;
  heldWaitingCount?: number;
  onOpenPalette?: () => void;
};

const PIN_DOT = [
  "bg-[var(--sf-needs)]",
  "bg-[var(--sf-running)]",
  "bg-[#3a3d44]",
] as const;

export function AppRail({
  activeId,
  onNavigate,
  waitingCount = 0,
  inFlightCount = 0,
  health,
  workspaceName,
  workspaceSubtitle,
  heldWaitingCount = 0,
  onOpenPalette,
}: AppRailProps) {
  const pins = usePinnedPipelines();
  const providers = useProviderSummary();
  const slotKinds = health ? capacitySlotKinds(health, heldWaitingCount) : [];
  const hint = capacityHintLine(heldWaitingCount);
  const providerIconClass = providers.failed
    ? " text-[var(--sf-fail)]"
    : providers.loading
      ? " text-[var(--sf-text-3)]"
      : providers.connectedCount > 0
        ? " text-[var(--sf-ok)]"
        : " text-[var(--sf-text-3)]";

  return (
    <nav
      className="flex h-screen w-[232px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-r-[#ffffff0f] bg-[var(--sf-rail)] px-3 py-3.5 font-['Geist',sans-serif]"
      aria-label="App"
    >
      <div className="flex w-full flex-col gap-3 pb-3 pt-0">
        <div className="flex h-9 items-center gap-2.5 rounded-lg px-1.5">
          <div
            className="flex size-6 shrink-0 flex-col items-center justify-center gap-[3px] rounded-md border border-[#ffffff14] bg-[var(--sf-raised)]"
            aria-hidden="true"
          >
            <span className="block size-[5px] rounded-full bg-[var(--sf-needs)] shadow-[0px_0px_6px_rgba(245,181,68,0.8)]" />
            <span className="block size-[5px] rounded-full bg-[#3a3d44]" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-semibold leading-[1.2] text-[var(--sf-text-1)]">
              {workspaceName}
            </span>
            {workspaceSubtitle ? (
              <span
                className="truncate font-['Geist_Mono',monospace] text-xs leading-[1.3] text-[var(--sf-text-3)]"
                title={workspaceSubtitle}
              >
                {workspaceSubtitle}
              </span>
            ) : null}
          </div>
          <LuChevronsUpDown
            className="size-3.5 shrink-0 text-[var(--sf-text-3)]"
            aria-hidden="true"
          />
        </div>

        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-lg border border-[#ffffff12] bg-[var(--sf-panel)] px-2.5 text-left"
          onClick={() => onOpenPalette?.()}
          title="Command palette"
        >
          <LuSearch className="size-3.5 text-[var(--sf-text-3)]" aria-hidden="true" />
          <span className="flex-1 truncate text-[13px] text-[var(--sf-text-3)]">
            Search or run…
          </span>
          <Keycap>⌘K</Keycap>
        </button>

        <a
          className="flex h-8 items-center justify-center gap-2 rounded-lg bg-[var(--sf-text-1)] text-[13px] font-medium text-[var(--sf-ground)] no-underline"
          href="#/new"
          onClick={(e) => {
            e.preventDefault();
            onNavigate("new");
          }}
        >
          <LuPlus className="size-3.5" aria-hidden="true" />
          Start a run
        </a>
      </div>

      <div className="flex w-full flex-1 flex-col gap-0.5">
        {NAV_GROUPS.map((group, groupIndex) => (
          <div key={group.label}>
            <div
              className={`px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]${groupIndex > 0 ? " pt-3.5 pb-1.5" : ""}`}
            >
              {group.label}
            </div>
            {group.items.map((item) => {
              const active = activeId === item.id;
              const Icon = item.icon;
              return (
                <a
                  key={item.id}
                  className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 no-underline${
                    active ? " bg-[var(--sf-active)]" : ""
                  }${item.soon ? " opacity-60" : ""}`}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  aria-disabled={item.soon ? true : undefined}
                  onClick={(e) => {
                    if (item.soon) {
                      e.preventDefault();
                      return;
                    }
                    e.preventDefault();
                    onNavigate(item.id);
                  }}
                >
                  <Icon
                    className={`size-4 shrink-0${
                      active ? " text-[var(--sf-text-1)]" : " text-[var(--sf-text-3)]"
                    }`}
                    aria-hidden="true"
                  />
                  <span
                    className={`min-w-0 flex-1 truncate text-[13px]${
                      active
                        ? " font-medium text-[var(--sf-text-1)]"
                        : item.soon
                          ? " text-[var(--sf-text-3)]"
                          : " text-[var(--sf-text-2)]"
                    }`}
                  >
                    {item.label}
                  </span>
                  {item.soon ? (
                    <span className="rounded-sm border border-dashed border-[#ffffff2e] px-[5px] text-[11px] text-[var(--sf-text-3)]">
                      Soon
                    </span>
                  ) : null}
                  {item.badge === "waiting" && waitingCount > 0 ? (
                    <span className="rounded-full bg-[var(--sf-needs)] px-1.5 py-px font-['Geist_Mono',monospace] text-[11px] font-semibold text-[#1a1306] shadow-[0px_0px_10px_rgba(245,181,68,0.45)]">
                      {waitingCount}
                    </span>
                  ) : null}
                  {item.badge === "inFlight" && inFlightCount > 0 ? (
                    <span className="flex items-center gap-[5px]">
                      <span className="block size-1.5 rounded-full bg-[var(--sf-running)]" />
                      <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-running)]">
                        {inFlightCount}
                      </span>
                    </span>
                  ) : null}
                </a>
              );
            })}
          </div>
        ))}

        {pins.length > 0 ? (
          <>
            <div className="px-2.5 pb-1.5 pt-3.5 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Pinned pipelines
            </div>
            {pins.map((id, index) => (
              <a
                key={id}
                className="flex h-[30px] items-center gap-2.5 rounded-lg px-2.5 no-underline"
                href={`#/pipelines/${encodeURIComponent(id)}`}
                title={id}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(`pipelines/${id}`);
                }}
              >
                <span
                  className={`block size-1.5 rounded-full ${PIN_DOT[index % PIN_DOT.length]}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-2)]">
                  {id}
                </span>
              </a>
            ))}
          </>
        ) : null}
      </div>

      <div className="flex w-full flex-col gap-2.5 border-t border-t-[#ffffff0f] pt-3">
        <div className="flex flex-col gap-2 px-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--sf-text-2)]">Agent slots</span>
            {health ? (
              <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-1)]">
                {health.activeCount} / {health.maxConcurrent}
              </span>
            ) : (
              <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
                —
              </span>
            )}
          </div>
          {health ? (
            <div className="flex gap-[3px]" aria-hidden="true">
              {slotKinds.map((kind, i) => (
                <span
                  key={i}
                  className={`block h-1 flex-1 rounded-full ${capacitySlotClass(kind)}`}
                />
              ))}
            </div>
          ) : null}
          {hint ? (
            <p className="text-xs leading-[1.35] text-[var(--sf-text-3)]">{hint}</p>
          ) : null}
        </div>

        <a
          className="flex h-[30px] items-center gap-2 rounded-lg px-2.5 no-underline"
          href="#/settings"
          title="Provider settings"
          onClick={(e) => {
            e.preventDefault();
            onNavigate("settings");
          }}
        >
          <LuPlug
            className={`size-3.5 shrink-0${providerIconClass}`}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--sf-text-2)]">
            {providers.loading ? "Checking providers…" : providers.label}
          </span>
          <LuSettings className="size-3.5 shrink-0 text-[var(--sf-text-3)]" aria-hidden="true" />
        </a>
      </div>
    </nav>
  );
}
