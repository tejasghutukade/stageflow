import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createDraftPackage, type DraftPackage } from "../src/config/draftPackage.js";
import {
  catalogScanRootForDirectory,
  defaultWorkshopPackageDirectory,
  ensureCatalogScanRoot,
} from "../src/config/ensureCatalogScanRoot.js";
import { publishDraftPackage } from "../src/config/publishDraftPackage.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const MODEL = "anthropic/claude-sonnet-4-5";

const CATALOG_MANIFEST = [
  "version: 1",
  "catalog:",
  "  pipelines:",
  "    - examples",
  "  tasks:",
  "    - examples",
  "",
].join("\n");

function catalogDraft(id: string): DraftPackage {
  return {
    pipeline: {
      id,
      stages: [
        {
          id: "plan",
          entry: true,
          system_prompt: "Plan the work.",
          model: MODEL,
          io: {
            input: { schema: { type: "object" } },
            output: { schema: { type: "object" } },
          },
        },
      ],
    },
  };
}

describe("ensureCatalogScanRoot", () => {
  it("maps untitled saves onto one shared workshop root", () => {
    expect(defaultWorkshopPackageDirectory("LinkedIn Candidate Search")).toBe(
      "workshop/linkedin-candidate-search",
    );
    expect(catalogScanRootForDirectory("workshop/linkedin-candidate-search")).toBe(
      "workshop",
    );
    expect(catalogScanRootForDirectory("examples/linkedin-candidate-search")).toBe(
      "examples/linkedin-candidate-search",
    );
  });

  it("adds workshop once to pipelines and tasks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-catalog-root-"));
    const manifestPath = path.join(root, "stageflow.yaml");
    await writeFile(
      manifestPath,
      "version: 1\ncatalog:\n  pipelines:\n    - examples\n  tasks:\n    - examples\n",
      "utf8",
    );
    expect(
      await ensureCatalogScanRoot(root, "workshop/linkedin-candidate-search"),
    ).toBe(true);
    expect(await ensureCatalogScanRoot(root, "workshop/another")).toBe(false);
    const text = await readFile(manifestPath, "utf8");
    expect(text.match(/- workshop/g)).toHaveLength(2);
  });
});

describe("publishDraftPackage catalog scan", () => {
  it("lists workshop after a successful create", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const manifestPath = path.join(root, "stageflow.yaml");
      await writeFile(manifestPath, CATALOG_MANIFEST, "utf8");
      const published = await publishDraftPackage(
        root,
        {
          directory: "workshop/demo",
          draft: catalogDraft("demo"),
        },
        "create",
      );
      expect(published.write.ok).toBe(true);
      expect(published.catalogChanged).toBe(true);
      const text = await readFile(manifestPath, "utf8");
      expect(text).toMatch(/pipelines:[\s\S]*- workshop/);
      expect(text).toMatch(/tasks:[\s\S]*- workshop/);
    } finally {
      await cleanup();
    }
  });

  it("lists a named directory outside workshop", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const manifestPath = path.join(root, "stageflow.yaml");
      await writeFile(manifestPath, CATALOG_MANIFEST, "utf8");
      const published = await publishDraftPackage(
        root,
        {
          directory: "notes",
          draft: catalogDraft("notes-demo"),
        },
        "create",
      );
      expect(published.write.ok).toBe(true);
      expect(published.catalogChanged).toBe(true);
      const text = await readFile(manifestPath, "utf8");
      expect(text).toMatch(/pipelines:[\s\S]*- notes/);
      expect(text).toMatch(/tasks:[\s\S]*- notes/);
    } finally {
      await cleanup();
    }
  });

  it("leaves the catalog unchanged when create fails", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const manifestPath = path.join(root, "stageflow.yaml");
      await writeFile(manifestPath, CATALOG_MANIFEST, "utf8");
      const published = await publishDraftPackage(
        root,
        {
          directory: "workshop/bad",
          draft: {
            pipeline: {
              id: "bad",
              stages: [{ id: "plan", system_prompt: "x", model: MODEL }],
            },
          },
        },
        "create",
      );
      expect(published.write.ok).toBe(false);
      expect(published.catalogChanged).toBe(false);
      const text = await readFile(manifestPath, "utf8");
      expect(text).toBe(CATALOG_MANIFEST);
    } finally {
      await cleanup();
    }
  });
});

describe("draft HTTP catalog scan", () => {
  async function withDraftServer(root: string) {
    const store = createRunStore({ rootDir: root });
    await store.ensureProject(root);
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
    });
    const address = started.server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    return {
      base: `http://127.0.0.1:${address.port}`,
      async close() {
        await new Promise<void>((resolve, reject) => {
          started.server.close((err) => (err ? reject(err) : resolve()));
        });
        await store.close();
      },
    };
  }

  it("POST /api/drafts/create lists workshop", async () => {
    const { root, cleanup } = await initTempGitRepo();
    const manifestPath = path.join(root, "stageflow.yaml");
    await writeFile(manifestPath, CATALOG_MANIFEST, "utf8");
    const server = await withDraftServer(root);
    try {
      const res = await fetch(`${server.base}/api/drafts/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_root: root,
          directory: "workshop/http-demo",
          draft: catalogDraft("http-demo"),
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(201);
      expect(body.catalogChanged).toBeUndefined();
      expect(body.pipelinePath).toBe("workshop/http-demo/http-demo.pipeline.yaml");
      expect(body).toEqual(
        expect.objectContaining({
          pipelinePath: "workshop/http-demo/http-demo.pipeline.yaml",
          stagePaths: [],
        }),
      );
      const text = await readFile(manifestPath, "utf8");
      expect(text).toMatch(/pipelines:[\s\S]*- workshop/);
      expect(text).toMatch(/tasks:[\s\S]*- workshop/);
    } finally {
      await server.close();
      await cleanup();
    }
  });

  it("POST /api/drafts/overwrite lists the named directory", async () => {
    const { root, cleanup } = await initTempGitRepo();
    const manifestPath = path.join(root, "stageflow.yaml");
    await writeFile(manifestPath, CATALOG_MANIFEST, "utf8");
    const created = await createDraftPackage(root, {
      directory: "notes",
      draft: catalogDraft("notes-http"),
    });
    expect(created.ok).toBe(true);
    expect(await readFile(manifestPath, "utf8")).toBe(CATALOG_MANIFEST);
    const server = await withDraftServer(root);
    try {
      const res = await fetch(`${server.base}/api/drafts/overwrite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_root: root,
          directory: "notes",
          draft: catalogDraft("notes-http"),
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect(body.catalogChanged).toBeUndefined();
      expect(Object.keys(body).sort()).toEqual([
        "pipeline",
        "pipelinePath",
        "stagePaths",
      ]);
      const text = await readFile(manifestPath, "utf8");
      expect(text).toMatch(/pipelines:[\s\S]*- notes/);
      expect(text).toMatch(/tasks:[\s\S]*- notes/);
    } finally {
      await server.close();
      await cleanup();
    }
  });
});
