import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkshopChatPrompt,
  parseWorkshopChatAttachments,
  readWorkshopDocsReference,
} from "../src/workshop/chatAttachments.js";

describe("readWorkshopDocsReference", () => {
  it("reads docs/yaml-catalog.md from the package root", async () => {
    const ref = await readWorkshopDocsReference();
    expect(ref?.path).toBe("docs/yaml-catalog.md");
    expect(ref?.text).toContain("# YAML catalog");
  });

  it("falls back to the shipped author skill reference when docs/ is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-docs-ref-"));
    try {
      expect(await readWorkshopDocsReference(root)).toBeNull();
      const refDir = path.join(root, "skills", "stageflow-author", "references");
      await mkdir(refDir, { recursive: true });
      await writeFile(path.join(refDir, "catalog-mapping.md"), "# Catalog mapping\n", "utf8");
      expect(await readWorkshopDocsReference(root)).toEqual({
        path: "skills/stageflow-author/references/catalog-mapping.md",
        text: "# Catalog mapping\n",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildWorkshopChatPrompt", () => {
  it("fences each attachment longer than its longest backtick run", () => {
    const prompt = buildWorkshopChatPrompt(
      "hi",
      [{ name: "a.md", mediaType: "text/markdown", size: 9, content: "````x````" }],
      { path: "docs/yaml-catalog.md", text: "# ref" },
    );
    expect(prompt).toBe(
      [
        "hi",
        "Attached file: a.md\n`````\n````x````\n`````",
        "Stageflow YAML authoring reference (docs/yaml-catalog.md):\n```\n# ref\n```",
      ].join("\n\n"),
    );
  });
});

describe("parseWorkshopChatAttachments", () => {
  it("defaults mediaType and measures size from content", () => {
    const parsed = parseWorkshopChatAttachments([{ name: " notes.txt ", content: "é" }]);
    expect(parsed).toEqual({
      ok: true,
      attachments: [{ name: "notes.txt", mediaType: "text/plain", size: 2, content: "é" }],
    });
  });
});
