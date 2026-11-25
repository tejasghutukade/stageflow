import { readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/assets");
const MARKERS = [
  "@openuidev/react-lang",
  "@openuidev/react-ui",
  "@openuidev/lang-core",
  "@openuidev/observability",
  "@openuidev/devtools",
];
const LIVE_MARKER = "stageflow-live-renderer";
/** Measured lazy renderer gzip 144226 (JS + CSS) plus 10%. */
export const LIVE_CHUNK_GZIP_BUDGET = 158_649;
/** Measured live HTML gzip 8177 across the lazy chunk and its shared query cache, plus 10%. */
export const LIVE_HTML_CHUNK_GZIP_BUDGET = 8_995;

function files() {
  return readdirSync(root).filter((name) => name.endsWith(".js") || name.endsWith(".css"));
}

function staticImports(source) {
  const found = new Set();
  for (const match of source.matchAll(/from["']\.\/([A-Za-z0-9_.-]+\.(?:js|css))["']/g)) found.add(match[1]);
  for (const match of source.matchAll(/from["']([A-Za-z0-9_.-]+\.(?:js|css))["']/g)) found.add(match[1]);
  return found;
}

function allImports(source) {
  const found = staticImports(source);
  for (const match of source.matchAll(/import\(\s*["']\.\/([A-Za-z0-9_.-]+\.(?:js|css))["']/g)) found.add(match[1]);
  return found;
}

function graph(entryNames, readImports) {
  const seen = new Set();
  const queue = [...entryNames];
  while (queue.length > 0) {
    const name = queue.pop();
    if (!name || seen.has(name)) continue;
    const file = path.join(root, name);
    if (!statSafe(file)) continue;
    seen.add(name);
    const source = readFileSync(file, "utf8");
    for (const next of readImports(source)) {
      if (files().includes(next)) queue.push(next);
    }
  }
  return seen;
}

function statSafe(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function entryFromHtml(htmlName) {
  const html = readFileSync(path.resolve(root, "..", htmlName), "utf8");
  const scripts = [...html.matchAll(/assets\/([A-Za-z0-9_.-]+\.js)/g)].map((match) => match[1]);
  const styles = [...html.matchAll(/assets\/([A-Za-z0-9_.-]+\.css)/g)].map((match) => match[1]);
  return { scripts, styles };
}

if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.log("ui/dist/assets missing; skip");
  process.exit(0);
}

const main = entryFromHtml("index.html");
const mainGraph = graph([...main.scripts, ...main.styles], staticImports);
for (const name of mainGraph) {
  const text = readFileSync(path.join(root, name), "utf8");
  for (const marker of MARKERS) {
    if (text.includes(marker)) {
      console.error(`${name} is in the main graph and contains ${marker}`);
      process.exit(1);
    }
  }
}

const liveFiles = files().filter((name) => {
  if (name.startsWith("live-renderer") || name.startsWith("LiveArtifactRenderer")) return true;
  const text = readFileSync(path.join(root, name), "utf8");
  return text.includes(LIVE_MARKER);
});
if (liveFiles.length === 0) {
  console.error("live renderer chunk not found");
  process.exit(2);
}
const liveGraph = graph(liveFiles, allImports);
let gzip = 0;
const counted = [];
for (const name of liveGraph) {
  if (mainGraph.has(name)) continue;
  const bytes = readFileSync(path.join(root, name));
  gzip += gzipSync(bytes).length;
  counted.push(name);
}
console.log(`live renderer gzip ${gzip} across ${counted.length} files (budget ${LIVE_CHUNK_GZIP_BUDGET})`);
if (gzip > LIVE_CHUNK_GZIP_BUDGET) {
  console.error(`live renderer gzip ${gzip} exceeds ${LIVE_CHUNK_GZIP_BUDGET}`);
  process.exit(1);
}

const liveHtmlFiles = files().filter((name) => name.startsWith("live-html"));
if (liveHtmlFiles.length === 0) {
  console.error("live html chunk not found");
  process.exit(2);
}
for (const name of liveHtmlFiles) {
  if (mainGraph.has(name)) {
    console.error(`${name} is in the main graph`);
    process.exit(1);
  }
}
const liveHtmlGraph = graph(liveHtmlFiles, allImports);
let liveHtmlGzip = 0;
const liveHtmlCounted = [];
for (const name of liveHtmlGraph) {
  if (mainGraph.has(name)) continue;
  const bytes = readFileSync(path.join(root, name));
  liveHtmlGzip += gzipSync(bytes).length;
  liveHtmlCounted.push(name);
}
console.log(`live html gzip ${liveHtmlGzip} across ${liveHtmlCounted.length} files (budget ${LIVE_HTML_CHUNK_GZIP_BUDGET})`);
if (liveHtmlGzip > LIVE_HTML_CHUNK_GZIP_BUDGET) {
  console.error(`live html gzip ${liveHtmlGzip} exceeds ${LIVE_HTML_CHUNK_GZIP_BUDGET}`);
  process.exit(1);
}
