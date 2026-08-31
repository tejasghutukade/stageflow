#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:3847";
const TIMEOUT_MS = 1500;

function usage() {
  return "Usage: detect-host.mjs [--base-url URL]";
}

function parseArgs(argv) {
  let baseUrl = DEFAULT_BASE_URL;
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

async function probe(baseUrl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: ac.signal });
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
console.log(`${status} ${baseUrl}`);
process.exit(status === "up" ? 0 : 1);
