import { mkdtemp, access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  repairMisnamedWorkshopCatalogFiles,
  repairWorkshopCatalogTree,
} from "../src/config/workshopCatalogRepair.js";

describe("workshopCatalogRepair", () => {
  it("renames misnamed pipeline and task yaml in a package directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-workshop-repair-"));
    await writeFile(
      path.join(root, "fanout-fanin-temp.yaml"),
      "id: fanout-fanin-temp\nstages: []\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "fanout-fanin-temp.task.yml"),
      "id: fanout-fanin-temp\ngoal: ship\npipeline: fanout-fanin-temp\n",
      "utf8",
    );
    await writeFile(path.join(root, "start.yaml"), "id: start\nmodel: m\n", "utf8");

    const result = await repairMisnamedWorkshopCatalogFiles(root);
    expect(result.renamed).toEqual(
      expect.arrayContaining([
        { from: "fanout-fanin-temp.yaml", to: "fanout-fanin-temp.pipeline.yaml" },
        { from: "fanout-fanin-temp.task.yml", to: "fanout-fanin-temp.task.yaml" },
      ]),
    );
    await access(path.join(root, "fanout-fanin-temp.pipeline.yaml"));
    await access(path.join(root, "fanout-fanin-temp.task.yaml"));
    await access(path.join(root, "start.yaml"));
    const pipeline = await readFile(
      path.join(root, "fanout-fanin-temp.pipeline.yaml"),
      "utf8",
    );
    expect(pipeline).toContain("fanout-fanin-temp");
  });

  it("repairs configured catalog directories under a project root", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-tree-"));
    const workshopDir = path.join(projectRoot, "workshop");
    await mkdir(workshopDir, { recursive: true });
    await writeFile(
      path.join(workshopDir, "demo.yaml"),
      "id: demo\nstages: []\n",
      "utf8",
    );
    const result = await repairWorkshopCatalogTree(projectRoot, ["workshop"]);
    expect(result.renamed).toEqual([
      { from: "demo.yaml", to: "demo.pipeline.yaml" },
    ]);
  });
});
