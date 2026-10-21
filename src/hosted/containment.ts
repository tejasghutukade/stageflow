import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export function isContained(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export async function resolveDirectory(root: string): Promise<string> {
  const absolute = path.resolve(root);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(`package root does not exist: ${absolute}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`package root is not a directory: ${absolute}`);
  }
  return realpath(absolute);
}

export async function containedRealPath(
  rootReal: string,
  target: string,
): Promise<string> {
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new Error(`path is not readable: ${target}`);
  }
  if (!isContained(rootReal, real)) {
    throw new Error(`path escapes package root: ${target}`);
  }
  return real;
}
