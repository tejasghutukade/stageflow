import { describe, expect, it } from "vitest";
import {
  checkToolchainRequirements,
  type ToolchainManifest,
} from "../src/preflight/toolchain.js";

const manifest: ToolchainManifest = {
  tools: {
    node: { path: "/usr/bin/node", version: "22.19.0" },
    pnpm: { path: "/usr/bin/pnpm", version: "9.0.0" },
    odd: { path: "/usr/bin/odd", version: "not-a-semver-at-all" },
  },
};

describe("checkToolchainRequirements", () => {
  it("missing_tool when absent from manifest and PATH", () => {
    const result = checkToolchainRequirements(
      [{ tool: "definitely-missing-tool-xyz" }],
      { manifest, env: { PATH: "" } },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].status).toBe("missing_tool");
  });

  it("tool_version_mismatch when found version outside range", () => {
    const result = checkToolchainRequirements(
      [{ tool: "pnpm", version: ">=9.5" }],
      { manifest, env: { PATH: "" } },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].status).toBe("tool_version_mismatch");
    expect(result.checks[0].found).toBe("9.0.0");
  });

  it("ok when version satisfies", () => {
    const result = checkToolchainRequirements(
      [{ tool: "node", version: ">=20" }],
      { manifest, env: { PATH: "" } },
    );
    expect(result.ok).toBe(true);
    expect(result.checks[0].status).toBe("ok");
    expect(result.checks[0].origin).toBe("manifest");
  });

  it("unknown_version passes by default; fails with strict", () => {
    const loose = checkToolchainRequirements([{ tool: "odd", version: ">=1" }], {
      manifest,
      env: { PATH: "" },
    });
    expect(loose.checks[0].status).toBe("unknown_version");
    expect(loose.ok).toBe(true);

    const strict = checkToolchainRequirements([{ tool: "odd", version: ">=1" }], {
      manifest,
      env: { PATH: "" },
      strict: true,
    });
    expect(strict.ok).toBe(false);
  });

  it("existence-only require is ok when tool present", () => {
    const result = checkToolchainRequirements([{ tool: "node" }], {
      manifest,
      env: { PATH: "" },
    });
    expect(result.ok).toBe(true);
    expect(result.checks[0].status).toBe("ok");
  });
});
