import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalogScanRootForDirectory,
  defaultWorkshopPackageDirectory,
  ensureCatalogScanRoot,
} from "../src/config/ensureCatalogScanRoot.js";

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
