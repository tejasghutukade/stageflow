import { readFile } from "node:fs/promises";
import { parseStreamLogHeader } from "../runtime/stageStreamLog.js";

export type StreamLogTail = {
  text: string;
  nextOffset: number;
  truncated?: boolean;
  earliestOffset?: number;
};

/** Read new content from a stage's stream.log since a caller's last cursor. */
export async function readStreamLogTail(
  streamLogPath: string,
  sinceOffset: number | undefined,
): Promise<StreamLogTail> {
  let raw: Buffer;
  try {
    raw = await readFile(streamLogPath);
  } catch {
    return { text: "", nextOffset: 0 };
  }

  const { base, headerLength } = parseStreamLogHeader(raw);
  const contentBytes = raw.subarray(headerLength);
  const eof = base + contentBytes.length;

  if (sinceOffset === undefined || sinceOffset < base) {
    const truncated = sinceOffset !== undefined && sinceOffset < base;
    return {
      text: contentBytes.toString("utf8"),
      nextOffset: eof,
      ...(truncated ? { truncated: true, earliestOffset: base } : {}),
    };
  }

  if (sinceOffset >= eof) {
    return { text: "", nextOffset: eof };
  }

  const slice = contentBytes.subarray(sinceOffset - base);
  return { text: slice.toString("utf8"), nextOffset: eof };
}
