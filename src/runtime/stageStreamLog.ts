import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { STREAM_FLUSH_THROTTLE_MS } from "../agent/activityObserver.js";
import { redactSecrets } from "../agent/streamLogRedact.js";

const DEFAULT_CAP_BYTES = 256 * 1024;

/** First line of every stream.log: the logical byte offset of the content that follows. */
export const STREAM_LOG_HEADER_PREFIX = "BASE:";

export function encodeStreamLogHeader(base: number): string {
  return `${STREAM_LOG_HEADER_PREFIX}${base}\n`;
}

/** Split a stream.log buffer into its logical base offset and content bytes. */
export function parseStreamLogHeader(raw: Buffer): {
  base: number;
  headerLength: number;
} {
  const prefix = Buffer.from(STREAM_LOG_HEADER_PREFIX, "utf8");
  if (raw.subarray(0, prefix.length).equals(prefix)) {
    const newlineIdx = raw.indexOf(0x0a);
    if (newlineIdx !== -1) {
      const baseStr = raw.subarray(prefix.length, newlineIdx).toString("utf8");
      const base = Number(baseStr);
      if (Number.isFinite(base) && base >= 0) {
        return { base, headerLength: newlineIdx + 1 };
      }
    }
  }
  return { base: 0, headerLength: 0 };
}

async function appendChunk(
  streamLogPath: string,
  chunk: string,
  capBytes: number,
): Promise<void> {
  await mkdir(path.dirname(streamLogPath), { recursive: true });

  let base = 0;
  let contentBytes: Buffer;
  try {
    const raw = await readFile(streamLogPath);
    const parsed = parseStreamLogHeader(raw);
    base = parsed.base;
    contentBytes = raw.subarray(parsed.headerLength);
  } catch {
    contentBytes = Buffer.alloc(0);
  }

  contentBytes = Buffer.concat([contentBytes, Buffer.from(chunk, "utf8")]);

  const headerBytes = Buffer.from(encodeStreamLogHeader(base), "utf8");
  if (headerBytes.length + contentBytes.length > capBytes) {
    let dropBytes = Math.floor(contentBytes.length / 2);
    // Never split a multi-byte UTF-8 codepoint: skip past continuation bytes.
    while (
      dropBytes < contentBytes.length &&
      (contentBytes[dropBytes] & 0xc0) === 0x80
    ) {
      dropBytes++;
    }
    base += dropBytes;
    contentBytes = contentBytes.subarray(dropBytes);
  }

  const finalHeader = Buffer.from(encodeStreamLogHeader(base), "utf8");
  await writeFile(streamLogPath, Buffer.concat([finalHeader, contentBytes]));
}

export type StageStreamLogWriter = {
  onDelta(delta: string): void;
  /** Idempotent; resolves once any pending buffered text has been written to disk. */
  flush(): Promise<void>;
};

export function createStageStreamLogWriter(
  streamLogPath: string,
  options: { flushThrottleMs?: number; capBytes?: number } = {},
): StageStreamLogWriter {
  const flushThrottleMs = options.flushThrottleMs ?? STREAM_FLUSH_THROTTLE_MS;
  const capBytes = options.capBytes ?? DEFAULT_CAP_BYTES;

  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Serializes disk writes so the throttle timer and an eager flush() never race.
  let writeChain: Promise<void> = Promise.resolve();

  function flushNow(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buffer) return writeChain;
    const chunk = redactSecrets(buffer);
    buffer = "";
    writeChain = writeChain.then(() => appendChunk(streamLogPath, chunk, capBytes));
    return writeChain;
  }

  return {
    onDelta(delta: string) {
      if (!delta) return;
      buffer += delta;
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          void flushNow();
        }, flushThrottleMs);
      }
    },
    flush() {
      return flushNow();
    },
  };
}
