// node capture/sheet.mjs out.png cols img1 img2 ...  -> contact sheet via headless Chromium
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
const [out, cols, ...imgs] = process.argv.slice(2);
const c = Number(cols);
const w = Math.floor(1900 / c);
const html = `<body style="margin:0;background:#222;display:grid;grid-template-columns:repeat(${c},${w}px);gap:6px">${imgs
  .map((f) => `<div style="position:relative"><img style="width:${w}px;display:block" src="data:image/png;base64,${fs.readFileSync(f).toString("base64")}"><span style="position:absolute;left:4px;top:4px;background:#000a;color:#fff;font:12px monospace;padding:2px 4px">${path.basename(f)}</span></div>`)
  .join("")}</body>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 800 } });
await p.setContent(html);
await p.screenshot({ path: out, fullPage: true });
await b.close();
