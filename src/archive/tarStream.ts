import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import type { Writable } from "node:stream";

const BLOCK = 512;

export type TarEntryMeta = { mode: number; mtimeSeconds: number };

export type TarFileResult = { size: number; sha256: string };

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0");
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
  return Buffer.from(`${length}${body}`);
}

function header(name: string, size: number, type: string, meta: TarEntryMeta, linkName = ""): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(name, 0, Math.min(100, Buffer.byteLength(name)), "utf8");
  buf.write(octal(meta.mode & 0o7777, 8), 100, 8, "ascii");
  buf.write(octal(0, 8), 108, 8, "ascii");
  buf.write(octal(0, 8), 116, 8, "ascii");
  buf.write(octal(size, 12), 124, 12, "ascii");
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

  private async pax(name: string, linkName: string, meta: TarEntryMeta): Promise<void> {
    const records: Buffer[] = [];
    if (Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/.test(name)) records.push(paxRecord("path", name));
    if (linkName && (Buffer.byteLength(linkName) > 100 || /[^\x20-\x7e]/.test(linkName))) records.push(paxRecord("linkpath", linkName));
    if (records.length === 0) return;
    const body = Buffer.concat(records);
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

  async addFile(name: string, filePath: string, size: number, meta: TarEntryMeta): Promise<TarFileResult> {
    await this.pax(name, "", meta);
    await this.write(header(name, size, "0", meta));
    const hash = createHash("sha256");
    let sent = 0;
    if (size > 0) {
      const source = createReadStream(filePath, { start: 0, end: size - 1 });
      for await (const chunk of source) {
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
