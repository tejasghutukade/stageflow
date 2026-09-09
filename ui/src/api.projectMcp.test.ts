import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProjectMcp, postProjectMcpProbe } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("project mcp api clients", () => {
  it("GET /api/project-mcp returns names and transport only", async () => {
    const body = {
      status: "ok" as const,
      servers: [
        { name: "local", transport: "stdio" as const },
        { name: "github", transport: "http" as const },
      ],
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json(body),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchProjectMcp()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/project-mcp",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
    const payload = JSON.stringify(await fetchProjectMcp());
    expect(payload).not.toMatch(/"env"/);
    expect(payload).not.toMatch(/"headers"/);
    expect(payload).not.toMatch(/"args"/);
    expect(payload).not.toMatch(/"url"/);
  });

  it("POST probe hits one encoded name and forwards AbortSignal", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () =>
      Response.json({ name: "my/server", status: "connected" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      postProjectMcpProbe("my/server", { signal: controller.signal }),
    ).resolves.toEqual({ name: "my/server", status: "connected" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/project-mcp/my%2Fserver/probe",
      expect.objectContaining({
        method: "POST",
        signal: controller.signal,
      }),
    );
  });

  it("aborted probe rejects without hanging", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }),
    );
    const pending = postProjectMcpProbe("github", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
