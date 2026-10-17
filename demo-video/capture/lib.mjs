import { chromium } from "playwright-core";
import fs from "node:fs";

export const BASE = process.env.DEMO_BASE ?? "http://127.0.0.1:3900";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function api(path, init) {
  const res = await fetch(BASE + path, init);
  return res.json();
}

/** Record one scene to out/clips/<name>.webm. `fn(page, h)` drives the UI. */
export async function record(name, fn, { startPath = "/#/inbox", viewport = { width: 1600, height: 900 } } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(BASE + startPath);
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(1200);
  const out = `out/clips/${name}.webm`;
  fs.rmSync(out, { force: true });
  await page.screencast.start({ path: out, size: viewport, quality: 100, fps: 30 });
  await page.screencast.showActions({
    cursor: "pointer",
    duration: 600,
    style: { title: "display:none", point: "width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,.35);border:2px solid rgba(255,255,255,.8)" },
  });
  const h = {
    sleep,
    /** Click a locator with a short dwell so viewers can follow. */
    async click(loc, { before = 450, after = 700, position } = {}) {
      await loc.waitFor({ state: "visible", timeout: 20000 });
      await sleep(before);
      await loc.click(position ? { position } : {});
      await sleep(after);
    },
    async hover(loc, ms = 800) {
      await loc.waitFor({ state: "visible", timeout: 20000 });
      await loc.hover();
      await sleep(ms);
    },
    async type(loc, text, delay = 45) {
      await loc.waitFor({ state: "visible", timeout: 20000 });
      await loc.click();
      await sleep(250);
      await loc.pressSequentially(text, { delay });
      await sleep(400);
    },
    async scroll(page_, y, ms = 900) {
      await page_.mouse.wheel(0, y);
      await sleep(ms);
    },
  };
  try {
    await fn(page, h);
  } finally {
    await sleep(600);
    await page.screencast.stop();
    await browser.close();
  }
  console.log("recorded", out);
}
