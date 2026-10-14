import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";
import { ChannelError } from "./errors.js";
import { SECRET_REF_PATTERN } from "./secrets.js";
import type { ConnectionEntry, CredentialEntry, SecretRef } from "./types.js";

export const CONNECTIONS_FILE_LIMIT_BYTES = 262144;
export const MAX_CONNECTIONS = 100;
export const MAX_CREDENTIALS = 20;

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const providerSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const secretRefSchema = z.string().regex(SECRET_REF_PATTERN);
const secretFieldSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const secretsSchema = z.record(secretFieldSchema, secretRefSchema).default({});

const credentialSchema = z.object({
  id: idSchema,
  provider: providerSchema,
  secrets: secretsSchema,
}).strict();

const connectionSchema = z.object({
  id: idSchema,
  provider: providerSchema,
  displayName: z.string().min(1).max(200).optional(),
  enabled: z.boolean().default(true),
  credential: idSchema.optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: secretsSchema,
}).strict();

const fileSchema = z.object({
  version: z.literal(1),
  credentials: z.array(credentialSchema).max(MAX_CREDENTIALS).default([]),
  connections: z.array(connectionSchema).max(MAX_CONNECTIONS).default([]),
}).strict();

export type ConnectionsFile = {
  credentials: CredentialEntry[];
  connections: ConnectionEntry[];
};

export function parseConnectionsYaml(text: string): ConnectionsFile {
  const document = parseDocument(text, { uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length) throw new ChannelError("CHANNEL_INVALID_INPUT");
  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new ChannelError("CHANNEL_INVALID_INPUT");
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new ChannelError("CHANNEL_INVALID_INPUT");
  assertUnique(parsed.data.credentials.map(entry => entry.id));
  assertUnique(parsed.data.connections.map(entry => entry.id));
  return {
    credentials: parsed.data.credentials.map(entry => ({ ...entry, secrets: entry.secrets as Record<string, SecretRef> })),
    connections: parsed.data.connections.map(entry => ({ ...entry, secrets: entry.secrets as Record<string, SecretRef> })),
  };
}

function assertUnique(ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new ChannelError("CHANNEL_INVALID_INPUT");
}

/** A missing file is an empty configuration. Any other fault stops startup instead of half-applying. */
export function loadConnectionsFile(file: string): ConnectionsFile {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { credentials: [], connections: [] };
    throw new ChannelError("CHANNEL_STORAGE_FAILED");
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new ChannelError("CHANNEL_INVALID_INPUT");
    if (stat.size > CONNECTIONS_FILE_LIMIT_BYTES) throw new ChannelError("CHANNEL_RESOURCE_LIMIT");
    const bytes = Buffer.alloc(CONNECTIONS_FILE_LIMIT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > CONNECTIONS_FILE_LIMIT_BYTES) throw new ChannelError("CHANNEL_RESOURCE_LIMIT");
    return parseConnectionsYaml(bytes.toString("utf8", 0, length));
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    throw new ChannelError("CHANNEL_INVALID_INPUT");
  } finally {
    closeSync(descriptor);
  }
}
