import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderCatalogYaml } from "../src/config/preserveCatalogYaml.js";

const PIPELINE = `# My pipeline
id: review   # the id
model: anthropic/claude-sonnet-5-5
defaults: &defaults
  timeout: 30
notes: >
  A folded note that
  spans two lines.
independence: keep-me
stages:
  # the first stage
  - id: draft     # writes the draft
    uses: ../stages/draft.yaml
    with: { tone: dry,  length: 3 }
    route:
      - to: review
  - id: review
    uses: ../stages/review.yaml
    settings: *defaults
`;

function edit(source: string, change: (value: Record<string, unknown>) => void, keepUnknownTopLevel = true): string {
  const value = parse(source) as Record<string, unknown>;
  change(value);
  return renderCatalogYaml(source, value, { keepUnknownTopLevel });
}

function stages(value: Record<string, unknown>): Record<string, unknown>[] {
  return value.stages as Record<string, unknown>[];
}

describe("renderCatalogYaml keeps untouched text", () => {
  it("returns an unchanged file byte for byte", () => {
    expect(edit(PIPELINE, () => {})).toBe(PIPELINE);
  });

  it("changes one scalar and nothing else: comment spacing, flow maps, folded blocks and anchors stay", () => {
    const out = edit(PIPELINE, (value) => {
      value.model = "openai/gpt-4o-mini";
    });
    expect(out).toBe(PIPELINE.replace("anthropic/claude-sonnet-5-5", "openai/gpt-4o-mini"));
  });

  it("changes a value inside one stage without touching the other stage", () => {
    const out = edit(PIPELINE, (value) => {
      stages(value)[1]!.uses = "../stages/review-v2.yaml";
    });
    expect(out).toBe(PIPELINE.replace("../stages/review.yaml", "../stages/review-v2.yaml"));
  });

  it("keeps CRLF line endings", () => {
    const crlf = PIPELINE.replace(/\n/g, "\r\n");
    const out = edit(crlf, (value) => {
      value.model = "openai/gpt-4o-mini";
    });
    expect(out).toBe(crlf.replace("anthropic/claude-sonnet-5-5", "openai/gpt-4o-mini"));
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("adds a stage at the end and leaves every existing line as it was", () => {
    const out = edit(PIPELINE, (value) => {
      stages(value).push({ id: "publish", uses: "../stages/publish.yaml" });
    });
    expect(out.startsWith(PIPELINE)).toBe(true);
    expect(out.slice(PIPELINE.length)).toBe("  - id: publish\n    uses: ../stages/publish.yaml\n");
  });

  it("removes a stage and leaves the rest as it was", () => {
    const out = edit(PIPELINE, (value) => {
      value.stages = [stages(value)[0]];
    });
    expect(out).toBe(PIPELINE.replace("  - id: review\n    uses: ../stages/review.yaml\n    settings: *defaults\n", ""));
  });

  it("adds a key inside a stage without reformatting its siblings", () => {
    const out = edit(PIPELINE, (value) => {
      stages(value)[1]!.description = "checks the draft";
    });
    expect(out).toBe(
      PIPELINE.replace("    settings: *defaults\n", "    settings: *defaults\n    description: checks the draft\n"),
    );
  });

  it("keeps top-level keys the editor does not model", () => {
    const value = parse(PIPELINE) as Record<string, unknown>;
    delete value.independence;
    value.model = "x/y";
    const out = renderCatalogYaml(PIPELINE, value, { keepUnknownTopLevel: true });
    expect(out).toContain("independence: keep-me");
  });
});

describe("renderCatalogYaml keeps comments with their stage", () => {
  it("keeps a renamed stage's comments", () => {
    const out = edit(PIPELINE, (value) => {
      stages(value)[0]!.id = "write";
    });
    expect(out).toContain("  - id: write     # writes the draft\n");
    expect(out).toContain("  # the first stage\n");
  });

  it("moves comments with id-less uses wrappers when they are reordered or a new one is inserted", () => {
    const source = `id: wrap
stages:
  # alpha comment
  - uses: stages/alpha.stage.yaml   # alpha inline
  # beta comment
  - uses: stages/beta.stage.yaml    # beta inline
`;
    const reordered = edit(source, (value) => {
      value.stages = [...stages(value)].reverse();
    });
    const beta = reordered.indexOf("beta.stage.yaml");
    const alpha = reordered.indexOf("alpha.stage.yaml");
    expect(beta).toBeLessThan(alpha);
    expect(reordered).toMatch(/uses: stages\/alpha\.stage\.yaml\s+# alpha inline/);
    expect(reordered).toMatch(/uses: stages\/beta\.stage\.yaml\s+# beta inline/);

    const inserted = edit(source, (value) => {
      value.stages = [{ uses: "stages/zero.stage.yaml" }, ...stages(value)];
    });
    expect(inserted).toContain("  - uses: stages/alpha.stage.yaml   # alpha inline\n");
    expect(inserted).toContain("  - uses: stages/beta.stage.yaml    # beta inline\n");
    expect(inserted.indexOf("zero.stage.yaml")).toBeLessThan(inserted.indexOf("alpha.stage.yaml"));
    expect(parse(inserted)).toEqual({
      id: "wrap",
      stages: [{ uses: "stages/zero.stage.yaml" }, { uses: "stages/alpha.stage.yaml" }, { uses: "stages/beta.stage.yaml" }],
    });
  });

  it("always writes YAML that parses to the requested value", () => {
    const out = edit(PIPELINE, (value) => {
      value.stages = [{ id: "solo", uses: "../stages/solo.yaml", with: { a: [1, 2] } }];
      value.requires = ["git"];
    });
    const expected = parse(PIPELINE) as Record<string, unknown>;
    expected.stages = [{ id: "solo", uses: "../stages/solo.yaml", with: { a: [1, 2] } }];
    expected.requires = ["git"];
    expect(parse(out)).toEqual(expected);
    expect(out).toContain("# My pipeline\n");
    expect(out).toContain("notes: >\n  A folded note that\n  spans two lines.\n");
  });
});
