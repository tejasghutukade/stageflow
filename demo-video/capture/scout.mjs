import { chromium } from "playwright-core";
const base = "http://127.0.0.1:3900";
const routes = process.argv.slice(2);
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" })).newPage();
for (const r of routes) {
  await p.goto(`${base}/#/${r}`);
  await p.waitForTimeout(1800);
  const name = r.replace(/[^a-z0-9]+/gi, "_");
  await p.screenshot({ path: `out/scout/${name}.png` });
  console.log("shot", r);
}
await b.close();
