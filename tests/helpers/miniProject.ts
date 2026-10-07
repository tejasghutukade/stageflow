import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FIXTURES_ROOT } from "./fixturePaths.js";

export async function plantMiniProject(root: string): Promise<string> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  await cp(
    path.join(FIXTURES_ROOT, "pipelines", "single.pipeline.yaml"),
    path.join(root, "pipelines", "single.pipeline.yaml"),
  );
  await cp(
    path.join(FIXTURES_ROOT, "stages", "clarify.yaml"),
    path.join(root, "stages", "clarify.yaml"),
  );
  await writeFile(path.join(root, ".git"), "");
  return path.join(root, "pipelines", "single.pipeline.yaml");
}
