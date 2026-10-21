import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("controlToken storage", () => {
  it("returns Authorization when a token is set", async () => {
    const { authorizationHeaders, getControlToken, setControlToken } =
      await import("./controlToken");
    setControlToken("t".repeat(32));
    expect(getControlToken()).toBe("t".repeat(32));
    expect(authorizationHeaders()).toEqual({
      Authorization: `Bearer ${"t".repeat(32)}`,
    });
  });

  it("omits Authorization when empty", async () => {
    const { authorizationHeaders, setControlToken } = await import(
      "./controlToken"
    );
    setControlToken("");
    expect(authorizationHeaders()).toEqual({});
  });
});

describe("api Authorization attachment", () => {
  it("includes Authorization from localStorage on api()", async () => {
    const { setControlToken } = await import("./controlToken");
    setControlToken("u".repeat(32));
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ runs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    // re-stub after resetModules
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    });
    const { fetchRuns } = await import("./client");
    await fetchRuns();
    expect(fetchMock).toHaveBeenCalled();
    const init = (fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${"u".repeat(32)}`);
  });
});
