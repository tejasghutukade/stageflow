import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CapacityHealth } from "../../api";
import { getControlToken, setControlToken } from "../../api/controlToken";
import type { CatalogSnapshot } from "../../catalog/source";
import { heldWaitingCount } from "../../catalog/views";
import { SettingsAppearance } from "../../components/SettingsAppearance";
import { cursorMcpConfigJson, mcpEndpointUrl } from "../../mcpConnect";
import type { ThemeMode } from "../../themePreference";
import type { NotifyPreference } from "../../useWaitingNotifications";
import {
  computeConcurrencySlots,
  isLoopbackHost,
} from "./settingsConcurrency";
import {
  LuCheck,
  LuCopy,
  LuGauge,
  LuHand,
  LuMinus,
  LuMonitor,
  LuPlus,
  LuServer,
} from "react-icons/lu";

export function SettingsEyebrow({ children }: { children: string }) {
  return (
    <span className="w-fit font-sans text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
      {children}
    </span>
  );
}

export function SettingsGeneralPanel({
  workshopModel,
  workshopModels,
  workshopModelSaving,
  workshopModelError,
  onWorkshopModelChange,
  health,
  formatDiskBytes,
}: {
  workshopModel: string;
  workshopModels: string[];
  workshopModelSaving: boolean;
  workshopModelError: string | null;
  onWorkshopModelChange: (value: string) => void;
  health?: CapacityHealth | null;
  formatDiskBytes: (n: number) => string;
}) {
  const DEFAULT = "cursor/auto";
  const diskRef = useRef(health?.disk);
  if (health?.disk) diskRef.current = health.disk;
  const disk = health?.disk ?? diskRef.current;

  return (
    <div className="flex flex-col gap-2.5">
      <SettingsEyebrow>General</SettingsEyebrow>
      <div className="flex flex-col overflow-clip rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)]">
        <SettingsRow
          label="Workshop model"
          hint="Default model for Workshop Author chat."
        >
          <select
            className="h-8 max-w-[min(280px,100%)] rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 font-sans text-[13px] text-[var(--sf-text-1)]"
            value={workshopModel || DEFAULT}
            disabled={workshopModelSaving}
            onChange={(e) => onWorkshopModelChange(e.target.value)}
          >
            {!workshopModels.includes(workshopModel || DEFAULT) ? (
              <option value={workshopModel || DEFAULT}>
                {workshopModel || DEFAULT}
              </option>
            ) : null}
            {workshopModels.length === 0 ? (
              <option value={DEFAULT}>{DEFAULT}</option>
            ) : (
              workshopModels.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))
            )}
          </select>
        </SettingsRow>
        {disk ? (
          <>
            <SettingsRow label="Runs on disk" mono={formatDiskBytes(disk.runs_bytes)} />
            <SettingsRow
              label="Free on volume"
              mono={formatDiskBytes(disk.free_bytes)}
              last
            />
          </>
        ) : (
          <p className="px-3.5 py-4 font-sans text-[13px] text-[var(--sf-text-3)]">
            Disk breakdown unavailable.
          </p>
        )}
      </div>
      {workshopModelError ? (
        <p className="font-sans text-[13px] text-[var(--sf-fail)]">{workshopModelError}</p>
      ) : null}
    </div>
  );
}

export function SettingsConcurrencyPanel({
  snapshot,
  health,
  healthEverLoaded,
  slotsSaving,
  slotsError,
  onSlotsChange,
}: {
  snapshot: CatalogSnapshot;
  health?: CapacityHealth | null;
  healthEverLoaded: boolean;
  slotsSaving: boolean;
  slotsError: string | null;
  onSlotsChange: (value: number) => void;
}) {
  const healthRef = useRef(health);
  if (health) healthRef.current = health;
  const effectiveHealth = health ?? healthRef.current;
  const held = effectiveHealth
    ? heldWaitingCount(snapshot, effectiveHealth)
    : 0;
  const { maxSlots, running, held: heldCount, free, slotStates } =
    computeConcurrencySlots(effectiveHealth, held);
  const stepperDisabled =
    slotsSaving || !healthEverLoaded || !effectiveHealth?.maxConcurrent;

  return (
    <>
      <div className="flex h-full flex-col gap-3.5 overflow-clip rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)] p-4">
        <div className="flex items-center gap-2">
          <LuGauge className="size-[15px] text-[var(--sf-text-2)]" aria-hidden="true" />
          <span className="min-w-0 flex-1 font-sans text-[15px] font-semibold text-[var(--sf-text-1)]">
            Concurrency
          </span>
          <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
            agent_slots
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="font-sans text-[13px] text-[var(--sf-text-2)]">
            Agent slots
          </span>
          <div className="flex h-8 items-center overflow-clip rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)]">
            <button
              type="button"
              className="flex h-full w-8 items-center justify-center border-r border-r-[#ffffff1a] disabled:opacity-50"
              disabled={stepperDisabled || maxSlots <= 1}
              aria-label="Decrease agent slots"
              onClick={() => onSlotsChange(Math.max(1, maxSlots - 1))}
            >
              <LuMinus className="size-3.5 text-[var(--sf-text-2)]" />
            </button>
            <span className="flex h-full w-11 items-center justify-center font-['Geist_Mono',monospace] text-[13px] font-medium text-[var(--sf-text-1)]">
              {healthEverLoaded && effectiveHealth ? maxSlots : "—"}
            </span>
            <button
              type="button"
              className="flex h-full w-8 items-center justify-center border-l border-l-[#ffffff1a] disabled:opacity-50"
              disabled={stepperDisabled || maxSlots >= 6}
              aria-label="Increase agent slots"
              onClick={() => onSlotsChange(Math.min(6, maxSlots + 1))}
            >
              <LuPlus className="size-3.5 text-[var(--sf-text-2)]" />
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-[3px]">
            {slotStates.map((state, index) => (
              <span
                key={index}
                className={`h-1.5 min-w-0 flex-1 rounded-full${
                  state === "running"
                    ? " bg-[var(--sf-running)]"
                    : state === "held"
                      ? " bg-[var(--sf-needs)] shadow-[0px_0px_10px_rgba(245,181,68,0.45)]"
                      : state === "free"
                        ? " bg-[#2a2d33]"
                        : " border border-dashed border-[#ffffff1f] bg-transparent"
                }`}
              />
            ))}
          </div>
          <div className="flex justify-between font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3.5 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-[var(--sf-running)]" />
            {running} running
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-[var(--sf-needs)]" />
            {heldCount} held
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-[#2a2d33]" />
            {free} free
          </span>
        </div>
        <div className="flex items-start gap-2 border-t border-t-[#ffffff12] pt-3">
          <LuHand className="mt-0.5 size-3.5 shrink-0 text-[var(--sf-needs)]" aria-hidden="true" />
          <p className="font-sans text-xs text-[var(--sf-text-2)]">
            Runs that wait on you keep their slot. You have {heldCount} held now.
          </p>
        </div>
      </div>
      {slotsError ? (
        <p className="font-sans text-[13px] text-[var(--sf-fail)]">
          Could not update slots: {slotsError}
        </p>
      ) : null}
    </>
  );
}

export function SettingsNotificationsPanel({
  notifyPreference,
  permission,
  onNotifySelect,
}: {
  notifyPreference: NotifyPreference;
  permission: NotificationPermission | "unsupported";
  onNotifySelect: (value: string) => void;
}) {
  const on = notifyPreference === "system";

  return (
    <div className="flex flex-col gap-2.5">
      <SettingsEyebrow>Notifications</SettingsEyebrow>
      <div className="flex flex-col overflow-clip rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)]">
        <div className="flex h-[52px] items-center gap-3 px-3.5 py-0">
          <LuMonitor className="size-[15px] shrink-0 text-[var(--sf-text-2)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <span className="block font-sans text-[13px] font-medium text-[var(--sf-text-1)]">
              Desktop notification when a gate opens
            </span>
            <span className="mt-0.5 block font-sans text-xs text-[var(--sf-text-3)]">
              Shows the stage and question. Click to jump to the gate.
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className={`relative h-5 w-[34px] shrink-0 rounded-full transition-colors${
              on
                ? " bg-[var(--sf-text-1)]"
                : " border border-[#ffffff1a] bg-[#2a2d33]"
            }`}
            onClick={() => onNotifySelect(on ? "off" : "system")}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full transition-[left]${
                on
                  ? " left-[14px] bg-[var(--sf-ground)]"
                  : " left-0.5 bg-[var(--sf-text-3)]"
              }`}
            />
          </button>
        </div>
      </div>
      {on && permission === "denied" ? (
        <p className="font-sans text-xs text-[var(--sf-text-3)]">
          Notifications blocked — enable in browser settings
        </p>
      ) : null}
    </div>
  );
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

export function SettingsMcpPanel() {
  const url = mcpEndpointUrl(window.location, {
    viteDev: import.meta.env.DEV,
  });
  const snippet = cursorMcpConfigJson(url);
  const showToken = !isLoopbackHost(window.location.hostname);
  const [token, setToken] = useState(() => getControlToken());
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);

  useEffect(() => {
    setControlToken(token);
  }, [token]);

  return (
    <div className="flex h-full flex-col gap-3 overflow-clip rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)] p-4">
        <div className="flex items-center gap-2">
          <LuServer className="size-[15px] text-[var(--sf-text-2)]" aria-hidden="true" />
          <span className="min-w-0 flex-1 font-sans text-[15px] font-semibold text-[var(--sf-text-1)]">
            MCP server
          </span>
          <span className="flex h-6 items-center gap-[5px] rounded-full bg-[#4cc38a1a] px-2">
            <LuCheck className="size-3 text-[var(--sf-ok)]" aria-hidden="true" />
            <span className="font-sans text-xs font-medium text-[var(--sf-ok)]">
              Listening
            </span>
          </span>
        </div>
        <div className="flex h-8 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] py-0 pl-2.5 pr-1">
          <code className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)]">
            {url}
          </code>
          <button
            type="button"
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-[#ffffff12] bg-[var(--sf-panel)] px-2"
            onClick={() => {
              void copyText(url).then(() => {
                setCopiedUrl(true);
                window.setTimeout(() => setCopiedUrl(false), 1500);
              });
            }}
          >
            <LuCopy className="size-3 text-[var(--sf-text-2)]" aria-hidden="true" />
            <span className="font-sans text-xs font-medium text-[var(--sf-text-2)]">
              {copiedUrl ? "Copied" : "Copy"}
            </span>
          </button>
        </div>
        <div className="flex flex-col overflow-clip rounded-[10px] border border-[#ffffff12] bg-[var(--sf-ground)]">
          <div className="flex h-[30px] items-center justify-between border-b border-b-[#ffffff12] px-3 py-0">
            <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
              .cursor/mcp.json
            </span>
            <button
              type="button"
              className="flex items-center gap-[5px]"
              onClick={() => {
                void copyText(snippet).then(() => {
                  setCopiedConfig(true);
                  window.setTimeout(() => setCopiedConfig(false), 1500);
                });
              }}
            >
              <LuCopy className="size-3 text-[var(--sf-text-3)]" aria-hidden="true" />
              <span className="font-sans text-xs text-[var(--sf-text-3)]">
                {copiedConfig ? "Copied" : "Copy config"}
              </span>
            </button>
          </div>
          <pre className="overflow-x-auto px-3 py-2.5 font-['Geist_Mono',monospace] text-xs leading-normal text-[var(--sf-text-2)]">
            {snippet}
          </pre>
        </div>
        {showToken ? (
          <label className="flex flex-col gap-1.5">
            <span className="font-sans text-[13px] font-medium text-[var(--sf-text-1)]">
              Control token
            </span>
            <span className="font-sans text-xs text-[var(--sf-text-3)]">
              Stored in this browser only. Send as Authorization Bearer for
              off-loopback hosts.
            </span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="STAGEFLOW_CONTROL_TOKEN"
              className="h-8 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)] outline-none"
            />
          </label>
        ) : null}
        {import.meta.env.DEV ? (
          <p className="font-sans text-xs text-[var(--sf-text-3)]">
            Vite hot-reload cannot serve MCP. This snippet uses the default sf
            ui URL. If that process used --port, paste the MCP endpoint printed
            on boot.
          </p>
        ) : null}
    </div>
  );
}

export function SettingsAppearancePanel({
  themeMode,
  onThemeChange,
  redesignOn,
  onRedesignChange,
}: {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  redesignOn: boolean;
  onRedesignChange: (on: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <SettingsEyebrow>Appearance</SettingsEyebrow>
      <div className="flex flex-col gap-4 overflow-clip rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)] p-4">
        <SettingsAppearance
          variant="redesign"
          value={themeMode}
          onChange={onThemeChange}
          redesignOn={redesignOn}
          onRedesignChange={onRedesignChange}
        />
      </div>
    </div>
  );
}

function SettingsRow({
  label,
  hint,
  mono,
  children,
  last,
}: {
  label: string;
  hint?: string;
  mono?: string;
  children?: ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 px-3.5 py-3.5${
        last ? "" : " border-b border-b-[#ffffff12]"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-sans text-[13px] font-medium text-[var(--sf-text-1)]">
          {label}
        </span>
        {hint ? (
          <span className="mt-0.5 block font-sans text-xs text-[var(--sf-text-3)]">
            {hint}
          </span>
        ) : null}
      </span>
      {children ?? (
        <span className="shrink-0 font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-2)]">
          {mono}
        </span>
      )}
    </div>
  );
}
