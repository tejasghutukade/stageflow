import { LIVE_LIBRARY_NAME, LIVE_LIBRARY_VERSION } from "../../../api/artifacts";

export type LiveLibraryVersionStatus = "current" | "older" | "newer" | "unknown";

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function liveLibraryVersionStatus(library: {
  name?: string;
  version?: string;
} | null | undefined): LiveLibraryVersionStatus {
  if (!library || library.name !== LIVE_LIBRARY_NAME || typeof library.version !== "string") return "unknown";
  const parsed = parseVersion(library.version);
  const current = parseVersion(LIVE_LIBRARY_VERSION);
  if (!parsed || !current) return "unknown";
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index]! < current[index]!) return "older";
    if (parsed[index]! > current[index]!) return "newer";
  }
  return "current";
}

export function libraryPreviewMessage(library: { name?: string; version?: string } | null | undefined): string {
  const name = library?.name && library.name.length > 0 ? library.name : "unknown";
  const version = library?.version && library.version.length > 0 ? ` ${library.version}` : "";
  return `This artifact was written for library ${name}${version}; preview unavailable`;
}
