import { createHash } from "node:crypto";
import { once } from "node:events";
import { open } from "node:fs/promises";
import type { Writable } from "node:stream";

const BLOCK = 512;

export type TarEntryMeta = { mode: number; mtimeSeconds: number };

export type TarFileResult = { size: number; sha256: string };

/** The ustar size field is 11 octal digits, so a file of 8 GiB or more carries its size in a PAX record instead. */
export const USTAR_MAX_SIZE = 8 ** 11 - 1;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0");
}

/** The PAX extended header body an entry needs (long or non-ASCII names, a size past the ustar limit), or undefined when it needs none. */
export function paxBody(name: string, linkName: string, size: number): Buffer | undefined {
  const records: Buffer[] = [];
  if (size > USTAR_MAX_SIZE) records.push(paxRecord("size", String(size)));
  if (Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/.test(name)) records.push(paxRecord("path", name));
  if (linkName && (Buffer.byteLength(linkName) > 100 || /[^\x20-\x7e]/.test(linkName))) records.push(paxRecord("linkpath", linkName));
  return records.length === 0 ? undefined : Buffer.concat(records);
}

export function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
  return Buffer.from(`${length}${body}`);
}

export function header(name: string, size: number, type: string, meta: TarEntryMeta, linkName = ""): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(name, 0, Math.min(100, Buffer.byteLength(name)), "utf8");
  buf.write(octal(meta.mode & 0o7777, 8), 100, 8, "ascii");
  buf.write(octal(0, 8), 108, 8, "ascii");
  buf.write(octal(0, 8), 116, 8, "ascii");
  buf.write(octal(size > USTAR_MAX_SIZE ? 0 : size, 12), 124, 12, "ascii");
  buf.write(octal(Math.max(0, Math.floor(meta.mtimeSeconds)), 12), 136, 12, "ascii");
  buf.write("        ", 148, 8, "ascii");
  buf.write(type, 156, 1, "ascii");
  if (linkName) buf.write(linkName, 157, Math.min(100, Buffer.byteLength(linkName)), "utf8");
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += buf[i]!;
  buf.write(`${octal(sum, 7)}\0 `, 148, 8, "ascii");
  return buf;
}

/**
 * Streams a ustar archive (PAX extended headers for long or non-ASCII names) into a writable. File contents are
 * piped chunk by chunk and hashed on the way, so a large tree never sits in memory. A file that changes while it is
 * read is cut or zero-padded to the size taken when it was opened, so the archive stays well formed.
 */
export class TarStream {
  constructor(private readonly out: Writable) {}

  private async write(chunk: Buffer): Promise<void> {
    if (!this.out.write(chunk)) await once(this.out, "drain");
  }

  private async padTo(size: number): Promise<void> {
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad > 0) await this.write(Buffer.alloc(pad, 0));
  }

  private async pax(name: string, linkName: string, meta: TarEntryMeta, size = 0): Promise<void> {
    const body = paxBody(name, linkName, size);
    if (!body) return;
    await this.write(header("PaxHeader", body.length, "x", meta));
    await this.write(body);
    await this.padTo(body.length);
  }

  async addBuffer(name: string, data: Buffer, meta: TarEntryMeta): Promise<TarFileResult> {
    await this.pax(name, "", meta);
    await this.write(header(name, data.length, "0", meta));
    await this.write(data);
    await this.padTo(data.length);
    return { size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }

  /**
   * Opens the file before anything is written, so a file that is gone or unreadable throws with the archive still well
   * formed and the caller can skip it. The size is the one the open file has now, not the one seen when the walk planned it.
   */
  async addFile(name: string, filePath: string, meta: TarEntryMeta): Promise<TarFileResult> {
    const handle = await open(filePath, "r");
    try {
      const size = (await handle.stat()).size;
      await this.pax(name, "", meta, size);
      await this.write(header(name, size, "0", meta));
      const hash = createHash("sha256");
      let sent = 0;
      if (size > 0) {
        for await (const chunk of handle.createReadStream({ start: 0, end: size - 1, autoClose: false })) {
          const piece = chunk as Buffer;
          hash.update(piece);
          sent += piece.length;
          await this.write(piece);
        }
      }
      if (sent < size) {
        const fill = Buffer.alloc(size - sent, 0);
        hash.update(fill);
        await this.write(fill);
      }
      await this.padTo(size);
      return { size, sha256: hash.digest("hex") };
    } finally {
      await handle.close();
    }
  }

  async addSymlink(name: string, target: string, meta: TarEntryMeta): Promise<void> {
    await this.pax(name, target, meta);
    await this.write(header(name, 0, "2", meta, target));
  }

  async addDirectory(name: string, meta: TarEntryMeta): Promise<void> {
    const dir = name.endsWith("/") ? name : `${name}/`;
    await this.pax(dir, "", meta);
    await this.write(header(dir, 0, "5", meta));
  }

  async finish(): Promise<void> {
    await this.write(Buffer.alloc(BLOCK * 2, 0));
  }
}
