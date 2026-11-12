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

describe("control token fragment", () => {
  it("exchanges #code=, removes the fragment, and stores the token", async () => {
    const token = "t".repeat(32);
    const replaceState = vi.fn();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ token }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: {
        hash: "#code=abc123",
        pathname: "/",
        search: "",
      },
      history: { state: null, replaceState },
    });
    vi.resetModules();
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
    const { getControlToken } = await import("./controlToken");
    await vi.waitFor(() => expect(getControlToken()).toBe(token));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/console-login",
      expect.objectContaining({ method: "POST" }),
    );
    expect(replaceState).toHaveBeenCalled();
    const next = String(replaceState.mock.calls[0]?.[2]);
    expect(next).toBe("/");
    expect(next).not.toContain("code=");
    expect(next).not.toContain(token);
  });

  it("keeps a stored token when the code exchange is rejected", async () => {
    const good = "g".repeat(32);
    store.set("stageflow.controlToken", good);
    const replaceState = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    vi.stubGlobal("window", {
      location: { hash: "#code=junk", pathname: "/", search: "" },
      history: { state: null, replaceState },
    });
    vi.resetModules();
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
    const { getControlToken } = await import("./controlToken");
    await vi.waitFor(() => expect(replaceState).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getControlToken()).toBe(good);
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
