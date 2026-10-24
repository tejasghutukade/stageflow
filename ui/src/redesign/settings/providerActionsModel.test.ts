import { describe, expect, it } from "vitest";
import {
  disconnectConfirmText,
  initialProviderActionsState as init,
  providerActions,
  reduceProviderActions as reduce,
  type ProviderActionsEvent,
  type ProviderActionsState,
} from "./providerActionsModel";

function run(events: ProviderActionsEvent[]) {
  let state: ProviderActionsState = init;
  const effects: Array<string | undefined> = [];
  for (const e of events) {
    const r = reduce(state, e);
    state = r.state;
    effects.push(r.effect);
  }
  return { state, effects };
}

describe("provider actions model", () => {
  it("opening the menu does not act or confirm", () => {
    const r = reduce(init, { type: "toggle-menu" });
    expect(r.state).toEqual({ menuOpen: true, confirming: false });
    expect(r.effect).toBeUndefined();
  });

  it("Disconnect item only enters the confirm step", () => {
    const open = reduce(init, { type: "toggle-menu" }).state;
    const r = reduce(open, { type: "choose", action: "disconnect" });
    expect(r.state).toEqual({ menuOpen: false, confirming: true });
    expect(r.effect).toBeUndefined();
  });

  it("Cancel and Esc leave the confirm step without effect", () => {
    for (const type of ["cancel", "escape"] as const) {
      const r = reduce({ menuOpen: false, confirming: true }, { type });
      expect(r.state).toEqual(init);
      expect(r.effect).toBeUndefined();
    }
  });

  it("Esc closes an open menu", () => {
    expect(reduce({ menuOpen: true, confirming: false }, { type: "escape" }).state).toEqual(init);
  });

  it("no event path emits a disconnect effect", () => {
    const { state, effects } = run([
      { type: "toggle-menu" },
      { type: "choose", action: "disconnect" },
      { type: "cancel" },
      { type: "toggle-menu" },
      { type: "escape" },
    ]);
    expect(state).toEqual(init);
    expect(effects.every((e) => e === undefined)).toBe(true);
  });

  it("replace key and sign in again emit effects and close the menu", () => {
    const open = { menuOpen: true, confirming: false };
    expect(reduce(open, { type: "choose", action: "replace-key" })).toEqual({
      state: init,
      effect: "replace-key",
    });
    expect(reduce(open, { type: "choose", action: "sign-in-again" }).effect).toBe("sign-in-again");
  });

  it("lists items by provider capability", () => {
    const ids = (canKey: boolean, canOauth: boolean) =>
      providerActions({ canKey, canOauth }).map((a) => a.id);
    expect(ids(true, false)).toEqual(["replace-key", "disconnect"]);
    expect(ids(false, true)).toEqual(["sign-in-again", "disconnect"]);
    expect(ids(true, true)).toEqual(["replace-key", "sign-in-again", "disconnect"]);
    expect(ids(false, false)).toEqual(["disconnect"]);
    expect(providerActions({ canKey: false, canOauth: false })[0].destructive).toBe(true);
  });

  it("confirm text names the provider", () => {
    expect(disconnectConfirmText("openrouter")).toBe(
      "Disconnect openrouter? Agents and evals that use it will stop working.",
    );
  });
});
