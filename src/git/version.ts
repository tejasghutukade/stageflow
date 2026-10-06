import { runGit } from "./exec.js";

export async function gitVersion(gitBin = "git"): Promise<string> {
  const result = await runGit({
    gitBin,
    args: ["version"],
    timeoutMs: 5_000,
  });
  const match = result.stdout.match(/git version\s+(\S+)/i);
  return match?.[1] ?? result.stdout.trim();
}
