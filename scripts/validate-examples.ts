import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "dist/cli.js");

if (!existsSync(cli)) {
  console.error("Build the CLI first: npm run build");
  process.exit(1);
}

const examplesRoot = path.join(repoRoot, "examples");
let failed = 0;

for (const name of readdirSync(examplesRoot).sort()) {
  const dir = path.join(examplesRoot, name);
  if (!statSync(dir).isDirectory()) continue;
  if (!existsSync(path.join(dir, "pipelines"))) continue;

  process.stdout.write(`validate ${name} ... `);
  try {
    execSync(`node "${cli}" validate --strict`, { cwd: dir, stdio: "pipe" });
    console.log("ok");
  } catch {
    console.log("FAILED");
    failed += 1;
  }
}

if (failed > 0) {
  process.exit(1);
}
