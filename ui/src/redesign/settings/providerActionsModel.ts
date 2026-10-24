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
