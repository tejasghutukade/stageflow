import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { CONNECTIONS_FILE_LIMIT_BYTES } from "./config.js";
import { ChannelError } from "./errors.js";
import type { ConnectionEntry, CredentialEntry } from "./types.js";

/** Plain-object form of an entry. Optional fields are omitted when unset. */
export type ConnectionYamlEntry = {
  id: string;
  provider: string;
  displayName?: string;
  enabled?: boolean;
  credential?: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
};

export function toYamlEntry(entry: Pick<ConnectionEntry, "id" | "provider" | "enabled" | "config" | "secrets"> & { displayName?: string; credential?: string }): ConnectionYamlEntry {
  return {
    id: entry.id,
    provider: entry.provider,
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    ...(entry.enabled === false ? { enabled: false } : {}),
    ...(entry.credential ? { credential: entry.credential } : {}),
    ...(Object.keys(entry.config).length ? { config: entry.config } : {}),
    ...(Object.keys(entry.secrets).length ? { secrets: entry.secrets } : {}),
  };
}

function open(text: string): Document.Parsed {
  const source = text.trim().length ? text : "version: 1\n";
  const document = parseDocument(source, { uniqueKeys: true, strict: true });
  if (document.errors.length) throw new ChannelError("CHANNEL_INVALID_INPUT");
  return document;
}

function sequence(document: Document.Parsed, key: "connections" | "credentials"): YAMLSeq {
  let seq = document.get(key, true);
  if (!isSeq(seq)) {
    document.set(key, document.createNode([]));
    seq = document.get(key, true);
  }
  const result = seq as YAMLSeq;
  result.flow = false;
  return result;
}

function indexOf(seq: YAMLSeq, id: string): number {
  return seq.items.findIndex(item => (item as YAMLMap | null)?.get?.("id") === id);
}

/** Edits keep comments and key order that the user wrote. */
export function addConnectionYaml(text: string, entry: ConnectionYamlEntry, credential?: { id: string; provider: string; secrets: Record<string, string> }): string {
  const document = open(text);
  if (credential) {
    const credentials = sequence(document, "credentials");
    if (indexOf(credentials, credential.id) < 0) credentials.add(document.createNode({ id: credential.id, provider: credential.provider, secrets: credential.secrets }));
  }
  const connections = sequence(document, "connections");
  if (indexOf(connections, entry.id) >= 0) throw new ChannelError("CHANNEL_OPERATION_CONFLICT", false, { connectionId: entry.id });
  connections.add(document.createNode(entry));
  return document.toString();
}

export type ConnectionPatch = {
  displayName?: string | null;
  enabled?: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
};

export function updateConnectionYaml(text: string, id: string, patch: ConnectionPatch): string {
  const document = open(text);
  const connections = sequence(document, "connections");
  const index = indexOf(connections, id);
  if (index < 0) throw new ChannelError("CHANNEL_NOT_FOUND", false, { connectionId: id });
  const node = connections.items[index] as YAMLMap;
  if (patch.displayName !== undefined) {
    if (patch.displayName === null || patch.displayName === "") node.delete("displayName"); else node.set("displayName", patch.displayName);
  }
  if (patch.enabled !== undefined) {
    if (patch.enabled) node.delete("enabled"); else node.set("enabled", false);
  }
  if (patch.config !== undefined) {
    if (Object.keys(patch.config).length) node.set("config", document.createNode(patch.config)); else node.delete("config");
  }
  for (const [field, ref] of Object.entries(patch.secrets ?? {})) node.setIn(["secrets", field], ref);
  return document.toString();
}

/** Removes the entry and any credential that no remaining connection uses. Returns what was dropped. */
export function removeConnectionYaml(text: string, id: string): { text: string; removedCredential?: string } {
  const document = open(text);
  const connections = sequence(document, "connections");
  const index = indexOf(connections, id);
  if (index < 0) throw new ChannelError("CHANNEL_NOT_FOUND", false, { connectionId: id });
  const credentialId = (connections.items[index] as YAMLMap).get("credential");
  connections.items.splice(index, 1);
  let removedCredential: string | undefined;
  if (typeof credentialId === "string") {
    const stillUsed = connections.items.some(item => (item as YAMLMap).get("credential") === credentialId);
    const credentials = document.get("credentials", true);
    if (!stillUsed && isSeq(credentials)) {
      const at = indexOf(credentials, credentialId);
      if (at >= 0) { credentials.items.splice(at, 1); removedCredential = credentialId; }
    }
  }
  return { text: document.toString(), ...(removedCredential ? { removedCredential } : {}) };
}

export function readConnectionsText(file: string): string {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  if (Buffer.byteLength(text) > CONNECTIONS_FILE_LIMIT_BYTES) throw new ChannelError("CHANNEL_RESOURCE_LIMIT");
  return text;
}

/**
 * Replaces the file atomically. A bind-mounted file cannot be renamed over, so that case falls
 * back to writing in place.
 */
export function writeConnectionsText(file: string, text: string): void {
  if (Buffer.byteLength(text) > CONNECTIONS_FILE_LIMIT_BYTES) throw new ChannelError("CHANNEL_RESOURCE_LIMIT");
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, text, { mode: 0o644 });
      renameSync(temporary, file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      try { unlinkSync(temporary); } catch { /* nothing to clean */ }
      if (code !== "EBUSY" && code !== "EXDEV" && code !== "EPERM") throw error;
      const descriptor = openSync(file, constants.O_WRONLY | constants.O_TRUNC);
      try { writeSync(descriptor, text); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    throw new ChannelError("CHANNEL_STORAGE_FAILED");
  }
}

export type { CredentialEntry };
