import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function withIsolatedHome<T>(
  fn: (home: string) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(tmpdir(), "sf-home-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    if (prevUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = prevUserProfile;
    }
    await rm(home, { recursive: true, force: true });
  }
}

export async function initTempGitRepo(): Promise<{
  root: string;
  nested: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-git-"));
  const nested = path.join(root, "nested", "sub");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(nested, { recursive: true });
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: root,
    stdio: "ignore",
  });
  await writeFile(path.join(root, "README"), "test\n");
  execFileSync("git", ["add", "README"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
  return {
    root,
    nested,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
