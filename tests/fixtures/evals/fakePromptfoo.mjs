import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "ok";
const cwd = process.cwd();
writeFileSync(path.join(cwd, "env.json"), JSON.stringify({ env: process.env, argv: args }));

if (mode === "crash") {
  process.stderr.write("SECRETSTDERR".repeat(400));
  process.exit(1);
}
if (mode === "ignore-term") process.on("SIGTERM", () => undefined);
else process.on("SIGTERM", () => process.exit(143));

const repeat = Number(args[args.indexOf("--repeat") + 1]);
const config = JSON.parse(readFileSync(path.join(cwd, "promptfooconfig.json"), "utf8"));
const Provider = (await import(pathToFileURL(path.join(cwd, "provider.mjs")).href)).default;
const hooks = await import(pathToFileURL(path.join(cwd, "hooks.mjs")).href);
const provider = new Provider();
const results = [];
let testIdx = 0;
for (const test of config.tests) {
  for (let repeatIndex = 0; repeatIndex < repeat; repeatIndex++, testIdx++) {
    const response = await provider.callApi("", { vars: test.vars, repeatIndex });
    const result = { testIdx, vars: test.vars, response, metadata: response.metadata };
    if (response.error) {
      result.failureReason = 2;
      result.error = response.error;
    } else {
      result.failureReason = 0;
      result.gradingResult = {
        componentResults: test.assert.map((a) => ({
          assertion: { metric: a.metric, type: a.type },
          pass: true,
          score: a.type === "llm-rubric" ? 5 : 1,
          reason: "fine",
          ...(a.type === "llm-rubric" ? { tokensUsed: { prompt: 100, completion: 50 } } : {}),
        })),
      };
    }
    await hooks.afterEach({ test, result });
    results.push(result);
    if (mode === "hang" || mode === "ignore-term") {
      setInterval(() => undefined, 1000);
      await new Promise(() => undefined);
    }
  }
}
writeFileSync(path.join(cwd, "results.json"), JSON.stringify({ results: { results } }));
process.exit(mode === "bad-results" ? 0 : 100);
