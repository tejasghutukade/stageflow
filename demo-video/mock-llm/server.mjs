// Scripted OpenAI-compatible chat-completions server for the demo.
// Drives real Stageflow stage/agent sessions with canned, deterministic replies.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = JSON.parse(fs.readFileSync(path.join(here, "script.json"), "utf8"));
const PORT = Number(process.env.MOCK_LLM_PORT ?? 4010);
const LOG = process.env.MOCK_LLM_LOG ?? path.join(here, "requests.log");
const TOKEN_DELAY_MS = Number(process.env.MOCK_LLM_TOKEN_DELAY_MS ?? 12);
const THINK_MS = Number(process.env.MOCK_LLM_THINK_MS ?? 1200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p?.text ?? "").join("\n");
  return "";
}

function sample(schema, key = "") {
  if (!schema || typeof schema !== "object") return "n/a";
  if (schema.enum) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (schema.anyOf) return sample(schema.anyOf[0], key);
  if (schema.oneOf) return sample(schema.oneOf[0], key);
  switch (t) {
    case "object": {
      const out = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = sample(v, k);
      return out;
    }
    case "array":
      return [sample(schema.items ?? {}, key)];
    case "integer":
    case "number":
      return schema.minimum ?? 1;
    case "boolean":
      return true;
    default:
      return `${key || "value"} recorded`;
  }
}

function findStage(messages) {
  const hay = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n")
    + "\n" + messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
  for (const [id, def] of Object.entries(script.stages)) {
    if (def.match.every((needle) => hay.includes(needle))) return { id, def };
  }
  return null;
}

function findAgent(messages) {
  const sys = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
  for (const [id, def] of Object.entries(script.agents)) {
    if (def.match.every((needle) => sys.includes(needle))) return { id, def };
  }
  return null;
}

const calledTools = (messages) => {
  const names = [];
  for (const m of messages) for (const c of m.tool_calls ?? []) names.push(c.function?.name);
  return names;
};

function plan(body) {
  const { messages = [], tools = [] } = body;
  const toolNames = tools.map((t) => t.function?.name ?? t.name);
  const called = calledTools(messages);
  const isStage = toolNames.includes("emit_stage_envelope");

  if (isStage) {
    const found = findStage(messages);
    const def = found?.def ?? { artifacts: [], envelope: {} };
    const toolMsgs = messages.filter((m) => m.role === "tool").length;
    const notes = def.thinking ?? "Working through the stage brief.";

    if (!called.includes("write_stage_artifact") && def.artifacts?.length) {
      const a = def.artifacts[0];
      return { text: notes, calls: [{ name: "write_stage_artifact", args: { path: a.path, content: a.content } }] };
    }
    if (def.ask && !called.includes("ask_operator")) {
      return { text: def.ask.preamble ?? "I need an operator decision before continuing.", calls: [{ name: "ask_operator", args: def.ask.params }] };
    }
    if (!called.includes("emit_stage_envelope")) {
      const emit = tools.find((t) => (t.function?.name ?? t.name) === "emit_stage_envelope");
      const schema = emit?.function?.parameters ?? emit?.parameters ?? {};
      const payloadSchema = schema.properties?.payload;
      const payload = { ...(payloadSchema ? sample(payloadSchema) : {}), ...(def.envelope?.payload ?? {}) };
      const envelope = {
        status: "success",
        summary: def.envelope?.summary ?? "Stage complete.",
        artifacts: (def.artifacts ?? []).map((a) => `stages/${found?.id ?? "stage"}/attempts/1/artifacts/${a.path}`),
        ...(payloadSchema || Object.keys(payload).length ? { payload } : {}),
      };
      return { text: def.wrapup ?? "Handing off.", calls: [{ name: "emit_stage_envelope", args: envelope }] };
    }
    return { text: "Stage complete.", calls: [] };
  }

  const agent = findAgent(messages);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const q = textOf(lastUser?.content).toLowerCase();
  const def = agent?.def;
  if (!def) return { text: "Understood.", calls: [] };
  const afterTool = messages[messages.length - 1]?.role === "tool";
  for (const rule of def.rules ?? []) {
    if (rule.when.some((w) => q.includes(w))) {
      if (rule.tool && !afterTool && toolNames.includes(rule.tool.name)) {
        return { text: rule.preamble ?? "", calls: [{ name: rule.tool.name, args: rule.tool.args }] };
      }
      return { text: afterTool && rule.after ? rule.after : rule.reply, calls: [] };
    }
  }
  return { text: def.fallback ?? "Happy to help — could you tell me a bit more?", calls: [] };
}

async function streamResponse(res, model, { text, calls }, wantUsage, promptLen) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  const send = (delta, finish = null, extra = {}) =>
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
  await sleep(THINK_MS);
  send({ role: "assistant", content: "" });
  const words = text.split(/(\s+)/);
  let i = 0;
  while (i < words.length) {
    send({ content: words.slice(i, i + 3).join("") });
    i += 3;
    await sleep(TOKEN_DELAY_MS * 3);
  }
  calls.forEach((c, idx) => {
    send({ tool_calls: [{ index: idx, id: `call_${Math.random().toString(36).slice(2, 10)}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] });
  });
  send({}, calls.length ? "tool_calls" : "stop");
  if (wantUsage) {
    const completion = Math.max(40, Math.round(text.length / 4) + calls.length * 90);
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: promptLen, completion_tokens: completion, total_tokens: promptLen + completion } })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      if (req.method === "GET" && req.url?.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "demo-1", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const decision = plan(body);
      try {
        fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), model: body.model, tools: (body.tools ?? []).map((t) => t.function?.name), last: textOf(body.messages?.at(-1)?.content).slice(0, 300), sys: textOf(body.messages?.[0]?.content).slice(0, 600), decision: { text: decision.text.slice(0, 80), calls: decision.calls.map((c) => c.name) } }) + "\n");
      } catch {}
      const promptLen = Math.round(raw.length / 4);
      await streamResponse(res, body.model ?? "demo-1", decision, body.stream_options?.include_usage ?? true, promptLen);
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`mock-llm listening on :${PORT}`));
