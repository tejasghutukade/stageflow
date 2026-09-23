import { describe, expect, it } from "vitest";
import { decideWorkspaceConfigTrust } from "../src/config/configOrigin.js";

describe("decideWorkspaceConfigTrust", () => {
  it("refuses workspace config for repository binding", () => {
    const d = decideWorkspaceConfigTrust({
      bindingKind: "repository",
      projectRoot: "/repo",
      source: "workspace",
    });
    expect(d.allow).toBe(false);
    expect(d.code).toBe("untrusted_config_origin");
  });

  it("allows workspace config for checkout binding", () => {
    const d = decideWorkspaceConfigTrust({
      bindingKind: "checkout",
      projectRoot: "/checkout",
      source: "workspace",
    });
    expect(d.allow).toBe(true);
    expect(d.origin).toBe("workspace");
  });

  it("allows when trust_workspace_config lists the root", () => {
    const d = decideWorkspaceConfigTrust({
      bindingKind: "repository",
      projectRoot: "/repo",
      trustWorkspaceConfig: ["/repo"],
      source: "workspace",
    });
    expect(d.allow).toBe(true);
  });

  it("allows catalog/inline without trust", () => {
    expect(
      decideWorkspaceConfigTrust({
        bindingKind: "repository",
        projectRoot: "/repo",
        source: "catalog",
      }).allow,
    ).toBe(true);
  });
});
