import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ChannelError } from "./errors.js";

export const STORE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_STORE_BYTES = 1048576;
const MAX_SECRET_LENGTH = 8192;

/** Read side used when resolving `store:NAME` references. */
export interface SecretReader {
  get(name: string): string | undefined;
}

/**
 * Secrets entered through the console. One JSON file, owner-only, replaced atomically. It lives
 * in the credential root next to provider auth, so it has the same trust level as that file:
 * anything running as the same user can read it. Values are never logged or returned by the API.
 */
export class ChannelSecretStore implements SecretReader {
  constructor(private readonly file: string) {}

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      if (statSync(this.file).size > MAX_STORE_BYTES) throw new ChannelError("CHANNEL_RESOURCE_LIMIT");
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ChannelError("CHANNEL_STORAGE_FAILED");
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed)) if (typeof value === "string") out[name] = value;
      return out;
    } catch (error) {
      if (error instanceof ChannelError) throw error;
      throw new ChannelError("CHANNEL_STORAGE_FAILED");
    }
  }

  private write(values: Record<string, string>): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(values), { mode: 0o600 });
      renameSync(temporary, this.file);
      chmodSync(this.file, 0o600);
    } catch {
      throw new ChannelError("CHANNEL_STORAGE_FAILED");
    }
  }

  get(name: string): string | undefined {
    return this.read()[name];
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  set(name: string, value: string): void {
    if (!STORE_NAME_PATTERN.test(name) || value.length === 0 || value.length > MAX_SECRET_LENGTH || /[\r\n\0]/.test(value)) {
      throw new ChannelError("CHANNEL_INVALID_INPUT");
    }
    this.write({ ...this.read(), [name]: value });
  }

  delete(name: string): void {
    const values = this.read();
    if (!(name in values)) return;
    delete values[name];
    this.write(values);
  }

  deleteWithPrefix(prefix: string): void {
    const values = this.read();
    const kept = Object.fromEntries(Object.entries(values).filter(([name]) => !name.startsWith(prefix)));
    if (Object.keys(kept).length !== Object.keys(values).length) this.write(kept);
  }
}
