export type DisplayCapability = "local_window" | "virtual_display" | "headless_only";
export type LiveViewKind = "none" | "relay" | "provider_view";
export type ViewerInput = "interactive" | "view_only" | "unsupported";
export type AttachStyle = "cdp" | "host_launched" | "unsupported";
export type ProfilePersistence = "host_volume" | "provider_managed" | "none";
export type DialogHandling = "relay_handled" | "provider_handled" | "unsupported";
export type PopupHandling = "relay_retarget" | "provider_handled" | "unsupported";

export type BrowserHostCapabilities = {
  display: DisplayCapability;
  liveView: LiveViewKind;
  viewerInput: ViewerInput;
  attach: AttachStyle;
  profilePersistence: ProfilePersistence;
  gracefulCloseRequired: boolean;
  hardAllowlist: boolean;
  dialogs: DialogHandling;
  popups: PopupHandling;
  permissionPolicy: boolean;
};

/** Every field is optional; an unset field reads as its conservative default. */
export type BrowserHostCapabilityRecord = Partial<BrowserHostCapabilities>;

export const DEFAULT_BROWSER_HOST_CAPABILITIES: Readonly<BrowserHostCapabilities> = {
  display: "headless_only",
  liveView: "none",
  viewerInput: "unsupported",
  attach: "unsupported",
  profilePersistence: "none",
  gracefulCloseRequired: false,
  hardAllowlist: false,
  dialogs: "unsupported",
  popups: "unsupported",
  permissionPolicy: false,
};

export function resolveBrowserHostCapabilities(
  record?: BrowserHostCapabilityRecord,
): BrowserHostCapabilities {
  const resolved: BrowserHostCapabilities = { ...DEFAULT_BROWSER_HOST_CAPABILITIES };
  if (record === undefined) return resolved;
  const target = resolved as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && key in DEFAULT_BROWSER_HOST_CAPABILITIES) target[key] = value;
  }
  return resolved;
}
