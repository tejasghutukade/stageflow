import type { IncomingMessage, ServerResponse } from "node:http";

/** Write one NDJSON frame, waiting for drain. (The request is already consumed here, so only the response state matters.) */
export async function writeFrame(res: ServerResponse, frame: unknown): Promise<void> {
  if (res.writableEnded || res.destroyed) return;
  if (res.write(`${JSON.stringify(frame)}\n`)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

export class BodyError extends Error {
  constructor(readonly reason: "too_large" | "not_json" | "not_object") {
    super(reason);
  }
}

/** Read a JSON object body. An empty body is `{}`. Throws BodyError so each surface can answer in its own words. */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > maxBytes) throw new BodyError("too_large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new BodyError("not_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BodyError("not_object");
  return parsed as Record<string, unknown>;
}
