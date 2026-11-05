#!/usr/bin/env node

const FALLBACK_PORT = 3847;
const TIMEOUT_MS = 1500;

function usage() {
  return "Usage: detect-host.mjs [--base-url URL]";
}

function defaultBaseUrl(env = process.env) {
  const raw = env.STAGEFLOW_SERVICE_PORT;
  const parsed = raw === undefined ? NaN : Number(raw);
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_PORT;
  return `http://127.0.0.1:${port}`;
}

function parseArgs(argv) {
  let baseUrl = defaultBaseUrl();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--base-url") {
      const value = argv[i + 1];
      if (!value) {
        console.error("detect-host: --base-url requires a URL");
        console.error(usage());
        process.exit(2);
      }
      baseUrl = value.replace(/\/$/, "");
      i += 1;
      continue;
    }
    console.error(`detect-host: unknown argument: ${arg}`);
    console.error(usage());
    process.exit(2);
  }
  return { baseUrl };
}

function clientHasControlToken(env = process.env) {
  const plain = env.STAGEFLOW_CONTROL_TOKEN;
  const filePath = env.STAGEFLOW_CONTROL_TOKEN_FILE;
  return (
    (plain !== undefined && plain.length > 0) ||
    (filePath !== undefined && filePath.length > 0)
  );
}

async function probe(baseUrl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/livez`, { signal: ac.signal });
    if (res.status !== 200) return "down";
    JSON.parse(await res.text());
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

const { baseUrl } = parseArgs(process.argv.slice(2));
const status = await probe(baseUrl);
const parts = [status, baseUrl];
if (clientHasControlToken()) {
  parts.push("bearer");
}
console.log(parts.join(" "));
process.exit(status === "up" ? 0 : 1);
