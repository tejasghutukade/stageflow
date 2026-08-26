import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "dist/cli.js");

if (!existsSync(cli)) {
  console.error("Build the CLI first: npm run build");
  process.exit(1);
}

if (!existsSync(path.join(repoRoot, "stageflow.yaml"))) {
  console.error("Missing repo-root stageflow.yaml");
  process.exit(1);
}

try {
  execSync(`node "${cli}" validate --strict`, { cwd: repoRoot, stdio: "inherit" });
} catch {
  process.exit(1);
}
