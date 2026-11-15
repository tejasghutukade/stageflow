import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

const BLOCK = 512;

export type TarEntry = {
  name: string;
  /** "file", "directory", "symlink", or "other" for hard links, devices and the like. */
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  mode: number;
  mtimeSeconds: number;
  linkName: string;
};

class ChunkReader {
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  constructor(private readonly iterator: AsyncIterator<Buffer>) {}

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    this.buffer = this.buffer.length === 0 ? next.value : Buffer.concat([this.buffer, next.value]);
    return true;
  }

  /** Exactly `count` bytes, or fewer when the stream ends. */
  async read(count: number): Promise<Buffer> {
    while (this.buffer.length < count && (await this.fill())) { /* keep filling */ }
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(out.length);
    return out;
  }

  /** Streams exactly `count` bytes as chunks; throws when the stream ends early. */
  async *chunks(count: number): AsyncGenerator<Buffer> {
    let left = count;
    while (left > 0) {
      if (this.buffer.length === 0 && !(await this.fill())) throw new Error("archive ended inside a file");
      const take = this.buffer.subarray(0, Math.min(left, this.buffer.length));
      this.buffer = this.buffer.subarray(take.length);
      left -= take.length;
      yield take;
    }
  }

  async skip(count: number): Promise<void> {
    for await (const chunk of this.chunks(count)) void chunk;
  }
}

function cString(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString("utf8");
}

function parseOctal(buf: Buffer): number {
  const text = cString(buf).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(body.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isInteger(length) || length <= space - offset + 1 || offset + length > body.length) break;
    const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

/**
 * Reads a .tar.gz sequentially without holding it in memory. `onEntry` gets each entry and an async iterator over its
 * bytes; whatever it does not consume is skipped. Handles PAX extended headers (long and non-ASCII names).
 */
export async function readTarGz(
  file: string,
  onEntry: (entry: TarEntry, data: AsyncIterable<Buffer>) => Promise<void>,
): Promise<void> {
  const raw = createReadStream(file);
  const source = createGunzip();
  raw.on("error", (error) => source.destroy(error));
  raw.pipe(source);
  const iterator = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  try {
    await walkTar(new ChunkReader(iterator), onEntry);
  } finally {
    // A check that throws mid-archive, or a caller that stops early, must not leave the file open.
    await iterator.return?.().catch(() => undefined);
    source.destroy();
    raw.destroy();
  }
}

async function walkTar(
  reader: ChunkReader,
  onEntry: (entry: TarEntry, data: AsyncIterable<Buffer>) => Promise<void>,
): Promise<void> {
  let pax: Record<string, string> = {};
  for (;;) {
    const header = await reader.read(BLOCK);
    if (header.length < BLOCK || header.every((byte) => byte === 0)) return;
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const headerSize = parseOctal(header.subarray(124, 136));
    if (typeflag === "x" || typeflag === "g") {
      const padding = (BLOCK - (headerSize % BLOCK)) % BLOCK;
      const body = await reader.read(headerSize);
      if (body.length < headerSize) throw new Error("archive ended inside a header");
      await reader.skip(padding);
      if (typeflag === "x") pax = { ...pax, ...parsePax(body) };
      continue;
    }
    const paxSize = pax.size !== undefined ? Number(pax.size) : undefined;
    const size = paxSize !== undefined && Number.isSafeInteger(paxSize) && paxSize >= 0 ? paxSize : headerSize;
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    const prefix = cString(header.subarray(345, 500));
    const name = pax.path ?? (prefix ? `${prefix}/${cString(header.subarray(0, 100))}` : cString(header.subarray(0, 100)));
    const linkName = pax.linkpath ?? cString(header.subarray(157, 257));
    pax = {};
    const kind: TarEntry["kind"] = typeflag === "0" || typeflag === "\0" ? "file" : typeflag === "5" ? "directory" : typeflag === "2" ? "symlink" : "other";
    const dataSize = kind === "file" ? size : 0;
    const entry: TarEntry = { name, kind, size: dataSize, mode: parseOctal(header.subarray(100, 108)), mtimeSeconds: parseOctal(header.subarray(136, 148)), linkName };
    let consumed = 0;
    const iterator = reader.chunks(dataSize);
    const data: AsyncIterable<Buffer> = {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of iterator) {
          consumed += chunk.length;
          yield chunk;
        }
      },
    };
    await onEntry(entry, data);
    if (consumed < dataSize) await reader.skip(dataSize - consumed);
    if (kind !== "file" && size > 0) await reader.skip(size);
    await reader.skip(kind === "file" ? padding : size > 0 ? padding : 0);
  }
}
