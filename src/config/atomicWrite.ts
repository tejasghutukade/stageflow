import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "../evals/canonical.js";
import type { ValidationFinding } from "./validateCatalog.js";

export type EvalsWriteErrorCode =
  | "EVAL_EXISTS"
  | "EVAL_NOT_FOUND"
  | "EVAL_INVALID"
  | "EVAL_DEFINITION_ID_MISMATCH"
  | "DATASET_EXISTS"
  | "DATASET_NOT_FOUND"
  | "DATASET_INVALID"
  | "DATASET_READ_ONLY"
  | "DATASET_CASE_OP_INVALID"
  | "DATASET_NAME_INVALID"
  | "SAMPLE_EXISTS"
  | "SAMPLE_SOURCE_MISSING";

export class EvalsWriteError extends Error {
  readonly code: EvalsWriteErrorCode;
  readonly findings: ValidationFinding[];

  constructor(code: EvalsWriteErrorCode, message: string, findings: ValidationFinding[] = []) {
    super(message);
    this.name = "EvalsWriteError";
    this.code = code;
    this.findings = findings;
  }
}

export class FileChangedError extends Error {
  readonly code = "FILE_CHANGED" as const;
  readonly currentHash: string;

  constructor(currentHash: string) {
    super("The file changed on disk since it was loaded");
    this.name = "FileChangedError";
    this.currentHash = currentHash;
  }
}

export function contentHash(bytes: string | Uint8Array): string {
  return sha256Hex(bytes);
}

export async function assertBaseHash(filePath: string, baseHash: string): Promise<string> {
  const current = contentHash(await readFile(filePath));
  if (current !== baseHash) throw new FileChangedError(current);
  return current;
}

export async function writeFileAtomic(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
