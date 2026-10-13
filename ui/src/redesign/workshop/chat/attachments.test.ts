import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentMetaList,
  formatBytes,
  looksLikeTextFile,
  planAttachmentAdds,
  textContentLooksBinary,
  userMessageCustom,
} from "./attachments";

const file = (name: string, size = 10, type = "") => ({ name, size, type });

describe("looksLikeTextFile", () => {
  it("accepts text media types and known extensions", () => {
    expect(looksLikeTextFile(file("notes.md"))).toBe(true);
    expect(looksLikeTextFile(file("plan.YAML"))).toBe(true);
    expect(looksLikeTextFile(file("x.bin", 1, "text/plain"))).toBe(true);
    expect(looksLikeTextFile(file("data", 1, "application/json"))).toBe(true);
    expect(looksLikeTextFile(file("Makefile"))).toBe(true);
  });

  it("rejects images and archives", () => {
    expect(looksLikeTextFile(file("shot.png", 1, "image/png"))).toBe(false);
    expect(looksLikeTextFile(file("bundle.zip", 1, "application/zip"))).toBe(false);
  });
});

describe("planAttachmentAdds", () => {
  it("enforces the five-file limit with one error line", () => {
    const existing = [{ name: "a.md" }, { name: "b.md" }, { name: "c.md" }];
    const plan = planAttachmentAdds(existing, [
      file("d.md"),
      file("e.md"),
      file("f.md"),
      file("g.md"),
    ]);
    expect(plan.accepted.map((f) => f.name)).toEqual(["d.md", "e.md"]);
    expect(plan.errors).toEqual(["Up to 5 files per message"]);
  });

  it("rejects oversize and non-text files and skips duplicates", () => {
    const plan = planAttachmentAdds([{ name: "a.md" }], [
      file("a.md"),
      file("big.txt", MAX_ATTACHMENT_BYTES + 1),
      file("ok.txt", MAX_ATTACHMENT_BYTES),
      file("pic.png", 10, "image/png"),
    ]);
    expect(plan.accepted.map((f) => f.name)).toEqual(["ok.txt"]);
    expect(plan.errors).toEqual([
      "big.txt is over 256 KB",
      "pic.png is not a text file",
    ]);
  });
});

describe("helpers", () => {
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("detects NUL bytes", () => {
    expect(textContentLooksBinary("a\u0000b")).toBe(true);
    expect(textContentLooksBinary("plain")).toBe(false);
  });

  it("reads attachment meta from message metadata and stored sessions", () => {
    expect(
      attachmentMetaList([
        { name: "a.md", size: 3, mediaType: "text/markdown", content: "abc" },
        { name: "b.txt", size: 1 },
        { size: 4 },
        "junk",
      ]),
    ).toEqual([
      { name: "a.md", size: 3, mediaType: "text/markdown" },
      { name: "b.txt", size: 1, mediaType: "text/plain" },
    ]);
    expect(attachmentMetaList(undefined)).toEqual([]);
  });

  it("builds user message custom metadata only when needed", () => {
    expect(userMessageCustom([], false)).toEqual({});
    const attachment = { name: "a.md", size: 1, mediaType: "text/markdown", content: "a" };
    expect(userMessageCustom([attachment], true)).toEqual({
      attachments: [attachment],
      context: { docs: true },
    });
  });
});
