import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunStore } from "../src/runstore/createStore.js";

const { mockPullsList } = vi.hoisted(() => ({ mockPullsList: vi.fn() }));
vi.mock("octokit", () => ({
  Octokit: class {
    rest = { pulls: { list: mockPullsList } };
  },
}));

import {
  GithubPollSource,
  defaultCreateGithubClient,
  type GithubPollClient,
  type GithubPollResponse,
  type GithubPullItem,
} from "../src/runtime/githubPollSource.js";
import type { TriggerFireEvent } from "../src/runtime/triggerPort.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const stageFixture = path.join(fixtures, "stages", "clarify.yaml");
const triggerFixture = (name: string) => path.join(fixtures, "triggers", name);

async function seedCatalog(root: string, triggerFixtureNames: string[]): Promise<void> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await mkdir(path.join(root, "triggers"), { recursive: true });

  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n  triggers:\n    - triggers\n",
  );
  await writeFile(
    path.join(root, "pipelines", "hello.pipeline.yaml"),
    "id: hello\nstages:\n  - id: clarify\n    uses: ../stages/clarify.yaml\n",
  );
  await writeFile(path.join(root, "stages", "clarify.yaml"), await readFile(stageFixture, "utf8"));
  await writeFile(
    path.join(root, "tasks", "my-task.task.yaml"),
    "id: my-task\ngoal: Say hello\n",
  );
  for (const name of triggerFixtureNames) {
    await writeFile(path.join(root, "triggers", name), await readFile(triggerFixture(name), "utf8"));
  }
}

async function mkdtempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sf-github-source-home-"));
}

function makePr(overrides: Partial<GithubPullItem> & { number: number }): GithubPullItem {
  return {
    title: `PR #${overrides.number}`,
    html_url: `https://github.com/acme/repo/pull/${overrides.number}`,
    state: "open",
    merged_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    user: { login: "octocat" },
    ...overrides,
  };
}

function scriptedClient(responses: GithubPollResponse[]): {
  client: GithubPollClient;
  listPulls: ReturnType<typeof vi.fn>;
} {
  const listPulls = vi.fn();
  let call = 0;
  listPulls.mockImplementation(async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return response;
  });
  return { client: { listPulls }, listPulls };
}

describe("GithubPollSource", () => {
  it("seeds the cursor on first sight without firing, then fires a dynamic-mode trigger for a new PR (single call per tick despite two triggers on the repo)", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, ["github-dynamic.trigger.yaml", "github-catalog.trigger.yaml"]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const seedPr = makePr({ number: 1, updated_at: "2026-01-01T00:00:00.000Z" });
      const newPr = makePr({
        number: 2,
        title: "Add widget",
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      });

      const { client, listPulls } = scriptedClient([
        { status: 200, etag: "W/\"etag-1\"", items: [seedPr] },
        { status: 200, etag: "W/\"etag-2\"", items: [newPr, seedPr] },
      ]);

      const source = new GithubPollSource({
        store,
        cwd: root,
        env: { GH_TOKEN: "test-token" },
        createGithubClient: () => client,
      });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.tick(onFire);
      expect(onFire).not.toHaveBeenCalled();
      expect(listPulls).toHaveBeenCalledTimes(1);

      await source.tick(onFire);

      expect(listPulls).toHaveBeenCalledTimes(2);
      expect(onFire).toHaveBeenCalledTimes(2);

      const dynamicCall = onFire.mock.calls.find((call) => call[0].triggerId === "github-dynamic");
      expect(dynamicCall?.[0].task).toMatchObject({
        goal: "Handle PR #2: Add widget",
        input: { number: 2, title: "Add widget", action: "opened", repo: "acme/widgets" },
      });

      const catalogCall = onFire.mock.calls.find((call) => call[0].triggerId === "github-catalog");
      expect(catalogCall?.[0]).toEqual({ triggerId: "github-catalog" });
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("does not re-fire when the repo is unchanged (304)", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, ["github-dynamic.trigger.yaml"]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const seedPr = makePr({ number: 1 });
      const newPr = makePr({ number: 2, updated_at: "2026-01-02T00:00:00.000Z" });

      const { client, listPulls } = scriptedClient([
        { status: 200, etag: "W/\"etag-1\"", items: [seedPr] },
        { status: 200, etag: "W/\"etag-2\"", items: [newPr, seedPr] },
        { status: 304 },
      ]);

      const source = new GithubPollSource({
        store,
        cwd: root,
        env: { GH_TOKEN: "test-token" },
        createGithubClient: () => client,
      });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.tick(onFire); // seed
      await source.tick(onFire); // fires once for newPr
      expect(onFire).toHaveBeenCalledTimes(1);

      await source.tick(onFire); // 304, unchanged
      expect(onFire).toHaveBeenCalledTimes(1);
      expect(listPulls).toHaveBeenCalledTimes(3);
      expect(listPulls.mock.calls[2][0]).toMatchObject({ etag: "W/\"etag-2\"" });
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("filters by event.match: only the matching action fires", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, ["github-match-closed.trigger.yaml"]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const seedPr = makePr({ number: 1 });
      const openedPr = makePr({
        number: 2,
        state: "open",
        updated_at: "2026-01-02T00:00:00.000Z",
      });
      const closedPr = makePr({
        number: 3,
        state: "closed",
        merged_at: null,
        updated_at: "2026-01-03T00:00:00.000Z",
      });

      const { client } = scriptedClient([
        { status: 200, etag: "W/\"etag-1\"", items: [seedPr] },
        { status: 200, etag: "W/\"etag-2\"", items: [closedPr, openedPr, seedPr] },
      ]);

      const source = new GithubPollSource({
        store,
        cwd: root,
        env: { GH_TOKEN: "test-token" },
        createGithubClient: () => client,
      });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.tick(onFire); // seed
      await source.tick(onFire);

      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire.mock.calls[0][0].task?.input).toMatchObject({ action: "closed", number: 3 });
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("skips a malformed event.config.repo with a logged warning without crashing the tick or blocking other valid triggers", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, ["github-malformed-repo.trigger.yaml", "github-valid-repo.trigger.yaml"]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const seedPr = makePr({ number: 1 });
      const { client, listPulls } = scriptedClient([
        { status: 200, etag: "W/\"etag-1\"", items: [seedPr] },
      ]);
      const logError = vi.fn();

      const source = new GithubPollSource({
        store,
        cwd: root,
        env: { GH_TOKEN: "test-token" },
        createGithubClient: () => client,
        logError,
      });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await expect(source.tick(onFire)).resolves.toBeUndefined();

      expect(listPulls).toHaveBeenCalledTimes(1);
      expect(listPulls.mock.calls[0][0]).toMatchObject({ owner: "acme", repo: "valid" });
      expect(logError).toHaveBeenCalledWith(expect.stringContaining("github-malformed"));
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("logs a clear error and skips the repo this tick when the secret is missing", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, ["github-dynamic.trigger.yaml"]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const { client, listPulls } = scriptedClient([{ status: 200, items: [makePr({ number: 1 })] }]);
      const logError = vi.fn();

      const source = new GithubPollSource({
        store,
        cwd: root,
        env: {},
        createGithubClient: () => client,
        logError,
      });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.tick(onFire);

      expect(listPulls).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith(expect.stringContaining("GH_TOKEN"));
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});

describe("defaultCreateGithubClient", () => {
  it("translates octokit's thrown 304 into a resolved not-modified response", async () => {
    mockPullsList.mockRejectedValueOnce(Object.assign(new Error("Not modified"), { status: 304 }));
    const client = defaultCreateGithubClient("fake-token");

    const response = await client.listPulls({ owner: "acme", repo: "widgets", etag: '"abc"' });

    expect(response).toEqual({ status: 304, items: [] });
  });

  it("still propagates a genuine error", async () => {
    mockPullsList.mockRejectedValueOnce(Object.assign(new Error("Bad credentials"), { status: 401 }));
    const client = defaultCreateGithubClient("fake-token");

    await expect(client.listPulls({ owner: "acme", repo: "widgets" })).rejects.toThrow(
      "Bad credentials",
    );
  });
});
