// Stub server: OpenAI chat-completions, Anthropic messages, and a Host-like /run-case callback.
import http from "node:http";
import { appendFileSync } from "node:fs";

const logFile = process.env.STUB_LOG;
const port = Number(process.env.STUB_PORT || 0);
let inflight = 0;
let maxInflight = 0;
const caseCalls = new Map();

function log(entry) {
  if (logFile) appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...entry }) + "\n");
}

function judgeReply(text) {
  if (text.includes("BADJSON")) return "I think this is fine, no JSON here.";
  const m = /\[\[SCORE=(\d)\]\]/.exec(text);
  const score = m ? Number(m[1]) : text.includes("good") ? 5 : 2;
  return JSON.stringify({ pass: score >= 4, score, reason: `stub judge gave ${score}` });
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const auth = req.headers["authorization"] || req.headers["x-api-key"] || "";
    const json = body ? JSON.parse(body) : {};
    if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
      const text = (json.messages || []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      log({ route: "openai", model: json.model, auth: String(auth).slice(0, 12), textLen: text.length, text });
      if (text.includes("HTTP500")) { res.statusCode = 500; res.setHeader("content-type","application/json"); res.end(JSON.stringify({ error: { message: "stub judge down", type: "server_error" } })); return; }
      if (text.includes("HTTP401")) { res.statusCode = 401; res.setHeader("content-type","application/json"); res.end(JSON.stringify({ error: { message: "bad key sk-SECRET-IN-BODY", type: "auth" } })); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "x", object: "chat.completion", model: json.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: judgeReply(text) } }],
        usage: { prompt_tokens: 111, completion_tokens: 22, total_tokens: 133 },
      }));
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/messages")) {
      const text = (json.messages || []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      log({ route: "anthropic", model: json.model, auth: String(auth).slice(0, 12), textLen: text.length, text });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "x", type: "message", role: "assistant", model: json.model, stop_reason: "end_turn",
        content: [{ type: "text", text: judgeReply(text) }],
        usage: { input_tokens: 111, output_tokens: 22 },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/run-case") {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      const key = json.caseId;
      caseCalls.set(key, (caseCalls.get(key) || 0) + 1);
      log({ route: "run-case", ...json, inflight, maxInflight, pid: json.pid });
      await new Promise((r) => setTimeout(r, Number(process.env.STUB_DELAY || 300)));
      inflight--;
      res.setHeader("content-type", "application/json");
      if (json.caseId === "c-fail") {
        res.end(JSON.stringify({ ok: false, code: "EVAL_STAGE_FAILED", message: "stub stage failed" }));
        return;
      }
      res.end(JSON.stringify({
        ok: true, stageRunId: `run-${json.caseId}-${json.repeatIndex}`,
        output: { kind: "envelope", status: "success", summary: json.caseId === "c2" ? "good summary" : "meh summary", payload: { answer: json.caseId === "c2" ? 42 : 7 }, artifacts: [] },
        latencyMs: 250, costUsd: 0.0123, tokensIn: 1000, tokensOut: 200,
      }));
      return;
    }
    if (req.url === "/stats") {
      res.end(JSON.stringify({ maxInflight, caseCalls: Object.fromEntries(caseCalls) }));
      return;
    }
    log({ route: "other", method: req.method, url: req.url });
    res.statusCode = 404; res.end("{}");
  });
});
server.listen(port, "127.0.0.1", () => {
  console.log("STUB_PORT=" + server.address().port);
});
