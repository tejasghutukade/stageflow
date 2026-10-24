import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type SystemOneRequest = {
  authorization: string | undefined;
  body: { model: string; state: string; questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string> }> };
};

export type SystemOneReply = { status: number; headers?: Record<string, string>; body?: unknown };

export type SystemOneFixture = {
  baseUrl: string;
  requests: SystemOneRequest[];
  /** Replies consumed first, one per request, before the default keyword-driven answer. */
  queue: SystemOneReply[];
  close: () => Promise<void>;
};

const BUCKETS = ["agent_wrong", "grader_wrong", "case_wrong", "unclear"];

function probs(choice: string, confidence: number): Record<string, number> {
  const rest = (1 - confidence) / 3;
  return Object.fromEntries(BUCKETS.map((b) => [b, b === choice ? confidence : rest]));
}

/** Keyword-driven answer in the System One response shape: FALSE_ALARM, BAD_CASE, UNSURE in the state pick the bucket. */
export function defaultAnswer(request: SystemOneRequest["body"]): unknown {
  const state = request.state;
  const [choice, confidence] = state.includes("FALSE_ALARM")
    ? ["grader_wrong", 0.91]
    : state.includes("BAD_CASE")
      ? ["case_wrong", 0.8]
      : state.includes("UNSURE")
        ? ["unclear", 0.4]
        : ["agent_wrong", 0.95];
  const answers: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(request.questions)) {
    if (name === "bucket") answers[name] = { choice, confidence, probabilities: probs(choice as string, confidence as number) };
    else if (name === "failure_type") {
      const types = Object.keys(question.criteria ?? {});
      answers[name] = { choice: types[0], confidence: 0.6, probabilities: {} };
    } else answers[name] = { noul: 0.8 };
  }
  return { model: request.model, answers, usage: { input_tokens: 1_000_000, output_tokens: 3 } };
}

async function readJson(req: IncomingMessage): Promise<SystemOneRequest["body"]> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as SystemOneRequest["body"];
}

/** A local HTTP server that speaks the System One shape; no test needs the network. */
export async function startSystemOneFixture(): Promise<SystemOneFixture> {
  const requests: SystemOneRequest[] = [];
  const queue: SystemOneReply[] = [];
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/systemone") {
      res.writeHead(404).end();
      return;
    }
    const body = await readJson(req);
    requests.push({ authorization: req.headers.authorization, body });
    const scripted = queue.shift();
    const reply = scripted ?? { status: 200, body: defaultAnswer(body) };
    res.writeHead(reply.status, { "Content-Type": "application/json", ...(reply.headers ?? {}) });
    res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    queue,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
