import { describe, expect, it } from "vitest";
import { isImageArtifactPath } from "./ArtifactReader";

describe("isImageArtifactPath", () => {
  it("matches png jpeg gif webp basenames", () => {
    expect(isImageArtifactPath("stages/screenshot/attempts/1/artifacts/page.png")).toBe(
      true,
    );
    expect(isImageArtifactPath("shot.JPEG")).toBe(true);
    expect(isImageArtifactPath("a.gif")).toBe(true);
    expect(isImageArtifactPath("b.webp")).toBe(true);
  });

  it("rejects markdown and extensionless names", () => {
    expect(isImageArtifactPath("screenshot.md")).toBe(false);
    expect(isImageArtifactPath("page")).toBe(false);
  });
});
