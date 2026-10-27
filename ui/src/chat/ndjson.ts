export type ChatMessageRecord = { id: string; role: "user" | "assistant"; text: string; createdAt: string };

export type ChatFrame =
  | { type: "delta"; text: string }
  | { type: "waiting" }
  | { type: "done"; message: ChatMessageRecord }
  | { type: "error"; code: string; message: string; retryAfterSec?: number };

/** Validates one decoded line; anything that is not a known frame is dropped. */
export function toFrame(value: unknown): ChatFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case "delta":
      return typeof frame.text === "string" ? { type: "delta", text: frame.text } : null;
    case "waiting":
      return { type: "waiting" };
    case "done": {
      const message = frame.message as Record<string, unknown> | undefined;
      if (!message || typeof message.id !== "string" || typeof message.text !== "string") return null;
      return {
        type: "done",
        message: {
          id: message.id,
          role: "assistant",
          text: message.text,
          createdAt: typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString(),
        },
      };
    }
    case "error":
      return {
        type: "error",
        code: typeof frame.code === "string" ? frame.code : "web_chat.failed",
        message: typeof frame.message === "string" ? frame.message : "",
        ...(typeof frame.retryAfterSec === "number" && Number.isFinite(frame.retryAfterSec) ? { retryAfterSec: frame.retryAfterSec } : {}),
      };
    default:
      return null;
  }
}

/** Reads a newline-delimited JSON stream, yielding each valid frame as soon as its line completes. */
export async function* readFrames<F = ChatFrame>(
  body: ReadableStream<Uint8Array>,
  decode: (value: unknown) => F | null = toFrame as (value: unknown) => F | null,
): AsyncGenerator<F, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (line: string): F | null => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      return decode(JSON.parse(trimmed));
    } catch {
      return null;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const frame = parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame) yield frame;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const last = parse(buffer);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
