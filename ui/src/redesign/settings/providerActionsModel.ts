export type ProviderActionId = "replace-key" | "sign-in-again" | "disconnect";

export type ProviderAction = {
  id: ProviderActionId;
  label: string;
  destructive?: boolean;
};

export type ProviderActionsState = {
  menuOpen: boolean;
  confirming: boolean;
};

export type ProviderActionsEvent =
  | { type: "toggle-menu" }
  | { type: "close-menu" }
  | { type: "choose"; action: ProviderActionId }
  | { type: "cancel" }
  | { type: "escape" };

export const initialProviderActionsState: ProviderActionsState = {
  menuOpen: false,
  confirming: false,
};

export function providerActions(caps: {
  canKey: boolean;
  canOauth: boolean;
}): ProviderAction[] {
  const items: ProviderAction[] = [];
  if (caps.canKey) items.push({ id: "replace-key", label: "Replace API key" });
  if (caps.canOauth) items.push({ id: "sign-in-again", label: "Sign in again" });
  items.push({ id: "disconnect", label: "Disconnect", destructive: true });
  return items;
}

/**
 * What Connect opens on a provider that is not connected: the API key field when the provider takes a key
 * (a browser sign-in stays one click away), the browser sign-in only when there is no key login.
 * A Host's browser sign-in waits for a callback on the Host's own machine, so a key is the dependable start.
 */
export function connectStart(caps: { canKey: boolean; canOauth: boolean }): "key" | "oauth" | null {
  if (caps.canKey) return "key";
  if (caps.canOauth) return "oauth";
  return null;
}

/** Label of the button that switches from the key field to the browser sign-in, named after the provider. */
export function browserSignInLabel(providerName: string | undefined): string {
  const name = providerName?.trim();
  return name ? `Sign in with ${name} instead` : "Sign in with browser instead";
}

export type ProviderActionsResult = {
  state: ProviderActionsState;
  effect?: "replace-key" | "sign-in-again";
};

export function reduceProviderActions(
  state: ProviderActionsState,
  event: ProviderActionsEvent,
): ProviderActionsResult {
  switch (event.type) {
    case "toggle-menu":
      return { state: { menuOpen: !state.menuOpen, confirming: false } };
    case "close-menu":
      return { state: { ...state, menuOpen: false } };
    case "choose":
      if (event.action === "disconnect") {
        return { state: { menuOpen: false, confirming: true } };
      }
      return {
        state: { menuOpen: false, confirming: false },
        effect: event.action,
      };
    case "cancel":
    case "escape":
      return { state: initialProviderActionsState };
  }
}

export function disconnectConfirmText(providerId: string): string {
  return `Disconnect ${providerId}? Agents and evals that use it will stop working.`;
}
