import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AskOperatorError,
  assertAnswerMatchesPrompt,
  normalizePromptIds,
  parseAskOperatorAnswer,
  parseAskOperatorParams,
} from "../src/tools/askOperator.js";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "askOperator",
);

const GOLDEN_KINDS = [
  "free_text",
  "confirm",
  "multi_question",
  "artifact_backed",
] as const;

async function loadFixture(name: string): Promise<unknown> {
  const raw = await readFile(path.join(fixtureDir, name), "utf8");
  return JSON.parse(raw) as unknown;
}

describe("askOperator golden fixtures", () => {
  it.each([...GOLDEN_KINDS])(
    "%s prompt/answer pair validates via U1",
    async (kind) => {
      const fixture = (await loadFixture(`${kind}.json`)) as {
        prompt: unknown;
        answer: unknown;
      };
      const prompt = normalizePromptIds(parseAskOperatorParams(fixture.prompt));
      const answer = parseAskOperatorAnswer(fixture.answer);
      expect(prompt.kind).toBe(kind);
      expect(answer.kind).toBe(kind);
      expect(() => assertAnswerMatchesPrompt(prompt, answer)).not.toThrow();
    },
  );

  it("invalid_kind fixture fails parse with stable message fragment", async () => {
    const fixture = (await loadFixture("invalid_kind.json")) as {
      prompt: unknown;
    };
    expect(() => parseAskOperatorParams(fixture.prompt)).toThrow(
      AskOperatorError,
    );
    expect(() => parseAskOperatorParams(fixture.prompt)).toThrow(
      /unsupported prompt kind "wizard"/,
    );
  });

  it("fixture inventory is only the four kinds plus invalid_kind", async () => {
    const files = (await readdir(fixtureDir))
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(files).toEqual([
      "artifact_backed.json",
      "confirm.json",
      "free_text.json",
      "invalid_kind.json",
      "multi_question.json",
    ]);
  });
});
