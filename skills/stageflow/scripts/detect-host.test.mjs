import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "detect-host.mjs");

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
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function runBase(baseUrl, opts = {}) {
  return run(["--base-url", baseUrl], opts);
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}`, port: addr.port });
    });
  });
}

test("classifies reachable 200 JSON /livez as up", async () => {
  const { server, baseUrl } = await listen((req, res) => {
    if (req.url === "/livez") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "live" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const result = await runBase(baseUrl);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `up ${baseUrl}`);
  } finally {
    server.close();
  }
});

test("a host that gates /api/health behind a bearer is still up", async () => {
  const { server, baseUrl } = await listen((req, res) => {
    if (req.url === "/livez") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "live" }));
      return;
    }
    res.writeHead(401, { "www-authenticate": "Bearer" });
    res.end();
  });
  try {
    const result = await runBase(baseUrl);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `up ${baseUrl}`);
  } finally {
    server.close();
  }
});

test("classifies non-200 /livez as down", async () => {
  const { server, baseUrl } = await listen((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
  try {
    const result = await runBase(baseUrl);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), `down ${baseUrl}`);
  } finally {
    server.close();
  }
});

test("classifies 200 non-JSON /livez as down", async () => {
  const { server, baseUrl } = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  try {
    const result = await runBase(baseUrl);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), `down ${baseUrl}`);
  } finally {
    server.close();
  }
});

test("classifies a hung /livez as down", async () => {
  const { server, baseUrl } = await listen(() => {});
  try {
    const result = await runBase(baseUrl);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), `down ${baseUrl}`);
  } finally {
    server.close();
  }
});

test("notes bearer when STAGEFLOW_CONTROL_TOKEN is set without sending it", async () => {
  const { server, baseUrl } = await listen((req, res) => {
    assert.equal(req.url, "/livez");
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "live" }));
  });
  try {
    const result = await runBase(baseUrl, {
      env: cleanEnv({
        STAGEFLOW_CONTROL_TOKEN: "b".repeat(32),
      }),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `up ${baseUrl} bearer`);
  } finally {
    server.close();
  }
});

test("default base URL follows STAGEFLOW_SERVICE_PORT", async () => {
  const { server, baseUrl, port } = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "live" }));
  });
  try {
    const result = await run([], {
      env: cleanEnv({ STAGEFLOW_SERVICE_PORT: String(port) }),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `up ${baseUrl}`);
  } finally {
    server.close();
  }
});

test("an unusable STAGEFLOW_SERVICE_PORT falls back to 3847", async () => {
  const result = await run([], {
    env: cleanEnv({ STAGEFLOW_SERVICE_PORT: "not-a-port" }),
  });
  assert.match(result.stdout.trim(), /^(up|down) http:\/\/127\.0\.0\.1:3847/);
});

test("an unknown argument is a usage error", async () => {
  const result = await run(["--nope"]);
  assert.equal(result.status, 2);
});
