import { execFileSync } from "node:child_process";
import fs from "node:fs";
const D = new URL("../node_modules/@remotion/compositor-darwin-arm64/", import.meta.url).pathname;
const out = {};
for (const f of fs.readdirSync("public/clips")) {
  if (!f.endsWith(".webm")) continue;
  const r = execFileSync(D + "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `public/clips/${f}`], { env: { ...process.env, DYLD_LIBRARY_PATH: D } });
  out[f.replace(".webm", "")] = Math.floor(Number(String(r).trim()) * 30) / 30;
}
fs.writeFileSync("src/clipDurations.json", JSON.stringify(out, null, 1));
console.log(out);
