import { accessSync, constants, mkdirSync } from "node:fs";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import { StoreOpenError } from "./sqlite/storeOpenError.js";

export function assertTmpdirUsable(
  env: NodeJS.ProcessEnv = process.env,
): string {
  let raw = env.TMPDIR ?? env.TMP ?? env.TEMP;
  if (raw === undefined || raw.trim() === "") {
    const soft = path.join(globalStageflowHome(), "tmp");
    process.env.TMPDIR = soft;
    raw = soft;
  }
  const dir = raw.trim();
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new StoreOpenError(
      `tmpdir_unusable: TMPDIR=${dir} is not writable (${message})`,
      "tmpdir_unusable",
      { path: dir },
    );
  }
  if (env.SQLITE_TMPDIR === undefined || env.SQLITE_TMPDIR.trim() === "") {
    process.env.SQLITE_TMPDIR = dir;
  }
  return dir;
}
