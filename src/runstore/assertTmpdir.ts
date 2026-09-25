import { accessSync, constants, mkdirSync } from "node:fs";
import { StoreOpenError } from "./sqlite/storeOpenError.js";

export function assertTmpdirUsable(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.TMPDIR ?? env.TMP ?? env.TEMP;
  if (raw === undefined || raw.trim() === "") {
    throw new StoreOpenError(
      "tmpdir_unusable: TMPDIR is unset. Set TMPDIR to a writable path (supported writable set: $STAGEFLOW_HOME and TMPDIR).",
      "tmpdir_unusable",
    );
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
