import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StoreOpenError } from "./sqlite/storeOpenError.js";

export const ALLOW_NETWORK_STORE_ENV = "STAGEFLOW_ALLOW_NETWORK_STORE";

const REFUSED_FSTYPES = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smbfs",
  "fuse.sshfs",
]);

const WARN_FSTYPES = new Set(["9p", "virtiofs"]);

export type MountInfoEntry = {
  mountPoint: string;
  fsType: string;
};

export type StoreFilesystemClassification = {
  fsType: string | null;
  mountPoint: string | null;
  status: "ok" | "refused" | "warn" | "skipped";
  reason?: string;
};

/**
 * Parse `/proc/self/mountinfo` lines into mount point + fstype pairs.
 * Field layout: ... mount-point ... - fstype ...
 */
export function parseMountInfo(content: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const sep = line.indexOf(" - ");
    if (sep < 0) continue;
    const left = line.slice(0, sep);
    const right = line.slice(sep + 3);
    const leftParts = left.split(" ");
    const rightParts = right.split(" ");
    if (leftParts.length < 5 || rightParts.length < 1) continue;
    const mountPoint = unescapeMountField(leftParts[4]!);
    const fsType = rightParts[0]!;
    entries.push({ mountPoint, fsType });
  }
  return entries;
}

function unescapeMountField(value: string): string {
  return value
    .replace(/\\040/g, " ")
    .replace(/\\011/g, "\t")
    .replace(/\\012/g, "\n")
    .replace(/\\134/g, "\\");
}

export function classifyPathFilesystem(
  resolvedPath: string,
  mounts: MountInfoEntry[],
): { fsType: string; mountPoint: string } | null {
  const target = path.resolve(resolvedPath);
  let best: MountInfoEntry | undefined;
  let bestLen = -1;
  for (const entry of mounts) {
    const mp = path.resolve(entry.mountPoint);
    if (target === mp || target.startsWith(mp.endsWith("/") ? mp : `${mp}/`)) {
      if (mp.length > bestLen) {
        best = entry;
        bestLen = mp.length;
      }
    }
  }
  if (best === undefined) return null;
  return { fsType: best.fsType, mountPoint: best.mountPoint };
}

export function classifyStoreFilesystem(options: {
  homePath: string;
  platform?: NodeJS.Platform;
  mountInfoContent?: string;
  env?: NodeJS.ProcessEnv;
}): StoreFilesystemClassification {
  const platform = options.platform ?? os.platform();
  if (platform !== "linux") {
    return {
      fsType: null,
      mountPoint: null,
      status: "skipped",
      reason: "filesystem detection is Linux-only (mountinfo)",
    };
  }

  let content = options.mountInfoContent;
  if (content === undefined) {
    try {
      content = readFileSync("/proc/self/mountinfo", "utf8");
    } catch (err) {
      return {
        fsType: null,
        mountPoint: null,
        status: "skipped",
        reason: `mountinfo unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const mounts = parseMountInfo(content);
  const match = classifyPathFilesystem(options.homePath, mounts);
  if (match === null) {
    return {
      fsType: null,
      mountPoint: null,
      status: "ok",
      reason: "no matching mount; treating as local",
    };
  }

  const env = options.env ?? process.env;
  const allowNetwork =
    env[ALLOW_NETWORK_STORE_ENV] === "1" ||
    env[ALLOW_NETWORK_STORE_ENV]?.toLowerCase() === "true";

  if (REFUSED_FSTYPES.has(match.fsType)) {
    if (allowNetwork) {
      return {
        fsType: match.fsType,
        mountPoint: match.mountPoint,
        status: "warn",
        reason: `network filesystem ${match.fsType} allowed via ${ALLOW_NETWORK_STORE_ENV}`,
      };
    }
    return {
      fsType: match.fsType,
      mountPoint: match.mountPoint,
      status: "refused",
      reason: `unsupported network filesystem ${match.fsType}`,
    };
  }

  if (WARN_FSTYPES.has(match.fsType)) {
    return {
      fsType: match.fsType,
      mountPoint: match.mountPoint,
      status: "warn",
      reason: `${match.fsType} may be unreliable for SQLite WAL`,
    };
  }

  return {
    fsType: match.fsType,
    mountPoint: match.mountPoint,
    status: "ok",
  };
}

export function assertStoreFilesystemSupported(
  homePath: string,
  options?: {
    platform?: NodeJS.Platform;
    mountInfoContent?: string;
    env?: NodeJS.ProcessEnv;
    warn?: (message: string) => void;
  },
): StoreFilesystemClassification {
  const classification = classifyStoreFilesystem({
    homePath,
    platform: options?.platform,
    mountInfoContent: options?.mountInfoContent,
    env: options?.env,
  });

  if (classification.status === "refused") {
    throw new StoreOpenError(
      `store_unsupported_filesystem: ${classification.fsType} at ${homePath}` +
        ` (mount ${classification.mountPoint}). Use a local volume, or set ${ALLOW_NETWORK_STORE_ENV}=1 to override (unsupported).`,
      "store_unsupported_filesystem",
      {
        fs_type: classification.fsType,
        mount_point: classification.mountPoint,
        path: homePath,
      },
    );
  }

  if (classification.status === "warn") {
    options?.warn?.(
      `stageflow: store filesystem warning: ${classification.reason ?? classification.fsType} at ${homePath}`,
    );
  }

  return classification;
}
