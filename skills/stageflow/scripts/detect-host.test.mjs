import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "detect-host.mjs");

function run(baseUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--base-url", baseUrl], {
      stdio: ["ignore", "pipe", "pipe"],
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

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test("classifies reachable 200 JSON /api/health as up", async () => {
  const { server, baseUrl } = await listen((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const result = await run(baseUrl);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `up ${baseUrl}`);
  } finally {
    server.close();
  }
});

test("classifies non-200 /api/health as down", async () => {
  const { server, baseUrl } = await listen((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
  try {
    const result = await run(baseUrl);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), `down ${baseUrl}`);
  } finally {
    server.close();
  }
});

test("classifies 200 non-JSON /api/health as down", async () => {
  const { server, baseUrl } = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  try {
    const result = await run(baseUrl);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), `down ${baseUrl}`);
  } finally {
    server.close();
  }
});

test("classifies a hung /api/health as down", async () => {
  const { server, baseUrl } = await listen(() => {});
  try {
    const result = await run(baseUrl);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), `down ${baseUrl}`);
  } finally {
    server.close();
  }
});
