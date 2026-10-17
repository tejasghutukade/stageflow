import { CLIPS, INTRO, PROBLEM, SOLUTION, ANYWHERE, OUTRO, clipFrames, TOTAL } from "../src/timeline.ts";
let f = 0;
const row = (n: string, d: number) => { console.log(n.padEnd(10), String(f).padStart(5), String(d).padStart(5), (f / 30).toFixed(1) + "s"); f += d; };
row("intro", INTRO); row("problem", PROBLEM); row("solution", SOLUTION);
for (const c of CLIPS) row(c.clip, clipFrames(c));
row("anywhere", ANYWHERE); row("outro", OUTRO);
console.log("total", TOTAL, (TOTAL / 30).toFixed(1) + "s");
