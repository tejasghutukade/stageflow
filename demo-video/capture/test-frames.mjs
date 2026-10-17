import { chromium } from "playwright-core";
import fs from "node:fs";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1920 / 1440, colorScheme: "dark" });
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:3900/#/runs"); await p.waitForTimeout(1500);
let n = 0;
await p.screencast.start({ size: { width: 1920, height: 1080 }, quality: 100, fps: 30, onFrame: ({ data, viewportWidth, viewportHeight, timestamp }) => {
  if (n++ >= 1) { fs.writeFileSync("out/frame5.jpg", data); console.log("frame", viewportWidth, viewportHeight, timestamp, data.length); }
} });
await p.getByText("Agents", { exact: true }).first().click();
await p.waitForTimeout(1500);
await p.screencast.stop();
console.log("frames", n);
await b.close();
