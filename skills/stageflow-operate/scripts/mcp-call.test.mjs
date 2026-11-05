import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-call.mjs");

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.STAGEFLOW_CONTROL_TOKEN;
  delete env.STAGEFLOW_CONTROL_TOKEN_FILE;
  delete env.STAGEFLOW_SERVICE_PORT;
  return { ...env, ...extra };
}

function run(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? cleanEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ status: -1, stdout, stderr: `${stderr}\ntimed out` });
    }, opts.timeoutMs ?? 8000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function writeToolResult(res, id, payload, isError = false) {
  const message = {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      ...(isError ? { isError: true } : {}),
    },
  };
  const data = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(data);
}

const HEALTH = {
  ok: true,
  activeRunIds: [],
  activeCount: 0,
  maxConcurrent: 3,
  slotsAvailable: 3,
  activeStageProcesses: 0,
  maxActiveStageProcesses: null,
};

test("get_health against a mock stateless host returns health JSON, exit 0", async () => {
  const { server, baseUrl } = await listen(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = await readJsonBody(req);
    if (body?.method !== "tools/call" || body?.params?.name !== "get_health") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected call" }));
      return;
    }
    writeToolResult(res, body.id, HEALTH);
  });
  try {
    const result = await run([
      "--base-url",
      baseUrl,
      "--tool",
      "get_health",
      "--args",
      "{}",
      "--stateless",
    ]);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), HEALTH);
  } finally {
    server.close();
  }
});

test("answer_gate with a well-formed free_text answer returns { ok: true }", async () => {
  const { server, baseUrl } = await listen(async (req, res) => {
    const body = await readJsonBody(req);
    const args = body?.params?.arguments ?? {};
    const answer = args.answer ?? {};
    if (
      body?.params?.name !== "answer_gate" ||
      args.runId !== "run-1" ||
      args.stageId !== "clarify" ||
      answer.kind !== "free_text" ||
      answer.text !== "payments"
    ) {
      writeToolResult(res, body?.id ?? 1, { error: "bad answer", status: 400 }, true);
      return;
    }
    writeToolResult(res, body.id, { ok: true });
  });
  try {
    const result = await run([
      "--base-url",
      baseUrl,
      "--tool",
      "answer_gate",
      "--args",
      JSON.stringify({
        runId: "run-1",
        stageId: "clarify",
        answer: { promptId: "prompt-1", kind: "free_text", text: "payments" },
      }),
      "--stateless",
    ]);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  } finally {
    server.close();
  }
});

test("wait_run timeout_ms returns reason timeout with exit 0", async () => {
  const { server, baseUrl } = await listen(async (req, res) => {
    const body = await readJsonBody(req);
    writeToolResult(res, body.id, {
      reason: "timeout",
      elapsed_ms: 1,
      until: "any",
      run: { id: "run-1", status: "running" },
    });
  });
  try {
    const result = await run([
      "--base-url",
      baseUrl,
      "--tool",
      "wait_run",
      "--args",
      JSON.stringify({ runId: "run-1", timeout_ms: 1, until: "any" }),
      "--stateless",
    ]);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).reason, "timeout");
  } finally {
    server.close();
  }
});

test("malformed JSON args fail before any network call", async () => {
  let hits = 0;
  const { server, baseUrl } = await listen((_req, res) => {
    hits += 1;
    res.writeHead(204);
    res.end();
  });
  try {
    const result = await run([
      "--base-url",
      baseUrl,
      "--tool",
      "get_health",
      "--args",
      "{not-json",
      "--stateless",
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /json|parse|args/i);
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});

test("isError true exits non-zero and prints the payload", async () => {
  const payload = { error: "stage not waiting", status: 409 };
  const { server, baseUrl } = await listen(async (req, res) => {
    const body = await readJsonBody(req);
    writeToolResult(res, body.id, payload, true);
  });
  try {
    const result = await run([
      "--base-url",
      baseUrl,
      "--tool",
      "answer_gate",
      "--args",
      JSON.stringify({
        runId: "run-1",
        stageId: "clarify",
        answer: { promptId: "p", kind: "free_text", text: "x" },
      }),
      "--stateless",
    ]);
    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, 2);
    assert.deepEqual(JSON.parse(result.stdout), payload);
  } finally {
    server.close();
  }
});

test("sends Authorization Bearer when STAGEFLOW_CONTROL_TOKEN is set", async () => {
  let sawAuth;
  const { server, baseUrl } = await listen(async (req, res) => {
    sawAuth = req.headers.authorization;
    const body = await readJsonBody(req);
    writeToolResult(res, body.id, HEALTH);
  });
  try {
    const token = "a".repeat(32);
    const result = await run(
      [
        "--base-url",
        baseUrl,
        "--tool",
        "get_health",
        "--args",
        "{}",
        "--stateless",
      ],
      {
        env: cleanEnv({ STAGEFLOW_CONTROL_TOKEN: token }),
      },
    );
    assert.equal(result.status, 0);
    assert.equal(sawAuth, `Bearer ${token}`);
  } finally {
    server.close();
  }
});

test("allows run_stage and get_envelope tool names", async () => {
  const seen = [];
  const { server, baseUrl } = await listen(async (req, res) => {
    const body = await readJsonBody(req);
    seen.push(body?.params?.name);
    writeToolResult(res, body.id, { ok: true });
  });
  try {
    for (const tool of ["run_stage", "get_envelope"]) {
      const result = await run([
        "--base-url",
        baseUrl,
        "--tool",
        tool,
        "--args",
        "{}",
        "--stateless",
      ]);
      assert.equal(result.status, 0, tool);
    }
    assert.deepEqual(seen, ["run_stage", "get_envelope"]);
  } finally {
    server.close();
  }
});

test("--stateless against a session-mode-only mock errors without hanging", async () => {
  const { server, baseUrl } = await listen((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: Session ID required" },
        id: null,
      }),
    );
  });
  try {
    const result = await run(
      [
        "--base-url",
        baseUrl,
        "--tool",
        "get_health",
        "--args",
        "{}",
        "--stateless",
      ],
      { timeoutMs: 4000 },
    );
    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, -1);
    assert.match(`${result.stdout}\n${result.stderr}`, /session|required|400/i);
  } finally {
    server.close();
  }
});

test("--probe prints up with the base URL when /livez answers JSON, exit 0", async () => {
  const { server, baseUrl } = await listen((req, res) => {
    if (req.url !== "/livez") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "live" }));
  });
  try {
    const result = await run(["--base-url", baseUrl, "--probe"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `up ${baseUrl}`);
  } finally {
    server.close();
  }
});

test("--probe appends bearer when a control token is set", async () => {
  const { server, baseUrl } = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "live" }));
  });
  try {
    const result = await run(["--base-url", baseUrl, "--probe"], {
      env: cleanEnv({ STAGEFLOW_CONTROL_TOKEN: "t".repeat(40) }),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `up ${baseUrl} bearer`);
  } finally {
    server.close();
  }
});

test("--probe prints down and exits 1 when nothing listens", async () => {
  const { server, baseUrl } = await listen((_req, res) => res.end());
  await new Promise((resolve) => server.close(resolve));
  const result = await run(["--base-url", baseUrl, "--probe"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), `down ${baseUrl}`);
});

test("--probe treats a non-JSON 200 as down", async () => {
  const { server, baseUrl } = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html></html>");
  });
  try {
    const result = await run(["--base-url", baseUrl, "--probe"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), `down ${baseUrl}`);
  } finally {
    server.close();
  }
});

test("default base URL follows STAGEFLOW_SERVICE_PORT", async () => {
  const { server, baseUrl } = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "live" }));
  });
  try {
    const port = new URL(baseUrl).port;
    const result = await run(["--probe"], {
      env: cleanEnv({ STAGEFLOW_SERVICE_PORT: port }),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `up http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
});

test("--list-tools prints the host tool names and the ones the script does not know", async () => {
  const { server, baseUrl } = await listen(async (req, res) => {
    const body = await readJsonBody(req);
    if (body?.method !== "tools/list") {
      res.writeHead(400);
      res.end();
      return;
    }
    const message = {
      jsonrpc: "2.0",
      id: body.id,
      result: { tools: [{ name: "get_run" }, { name: "brand_new_tool" }] },
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  });
  try {
    const result = await run(["--base-url", baseUrl, "--list-tools", "--stateless"]);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      tools: ["brand_new_tool", "get_run"],
      unknown_to_script: ["brand_new_tool"],
    });
  } finally {
    server.close();
  }
});

test("allows operate tools beyond the run set", async () => {
  const seen = [];
  const { server, baseUrl } = await listen(async (req, res) => {
    const body = await readJsonBody(req);
    seen.push(body?.params?.name);
    writeToolResult(res, body.id, { ok: true });
  });
  const tools = [
    "get_started",
    "get_waiting_summary",
    "cancel_run",
    "retry_stage",
    "resume_stage",
    "rerun",
    "export_run",
    "list_connections",
    "create_connection",
    "fire_trigger",
    "list_agent_sessions",
    "approve_agent_action",
  ];
  try {
    for (const tool of tools) {
      const result = await run([
        "--base-url",
        baseUrl,
        "--tool",
        tool,
        "--args",
        "{}",
        "--stateless",
      ]);
      assert.equal(result.status, 0, tool);
    }
    assert.deepEqual(seen, tools);
  } finally {
    server.close();
  }
});

test("rejects a tool name the host does not have, exit 2, no network call", async () => {
  const result = await run([
    "--base-url",
    "http://127.0.0.1:1",
    "--tool",
    "get_waiting",
    "--stateless",
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown tool/);
});

test("--timeout-ms must be a positive number", async () => {
  const result = await run([
    "--base-url",
    "http://127.0.0.1:1",
    "--tool",
    "get_health",
    "--timeout-ms",
    "abc",
  ]);
  assert.equal(result.status, 2);
});
