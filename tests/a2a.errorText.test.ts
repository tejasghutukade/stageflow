import { describe, expect, it } from "vitest";
import { a2aStatusView, pathForDisplay, scrubA2aPaths } from "../src/a2a/errorText.js";

describe("scrubA2aPaths", () => {
  it("makes paths under a known folder relative, including folders with spaces", () => {
    expect(scrubA2aPaths("ENOENT: no such file or directory, realpath '/data/sf home/workspace/a.schema.json'", ["/data/sf home"]))
      .toBe("ENOENT: no such file or directory, realpath 'workspace/a.schema.json'");
    expect(scrubA2aPaths("cannot read /data/sfhome", ["/data/sfhome/"])).toBe("cannot read .");
  });

  it("cuts any other absolute path to its last segment and leaves URLs and relative paths alone", () => {
    expect(scrubA2aPaths("Invalid stage in /srv/projects/x/p.pipeline.yaml: bad", [])).toBe("Invalid stage in p.pipeline.yaml: bad");
    expect(scrubA2aPaths("open 'C:\\Users\\me\\s.json'", [])).toBe("open 's.json'");
    expect(scrubA2aPaths("public_url https://ws.stage-flow.dev/a/b is invalid; see ./contracts/s.json", []))
      .toBe("public_url https://ws.stage-flow.dev/a/b is invalid; see ./contracts/s.json");
  });
});

describe("known folders match only at a path boundary", () => {
  it("does not cut a folder name that appears inside another path or as a prefix of a longer name", () => {
    expect(scrubA2aPaths("open '/srv/data/a2a.yaml'", ["/data"])).toBe("open 'a2a.yaml'");
    expect(scrubA2aPaths("open '/data2/a2a.yaml'", ["/data"])).toBe("open 'a2a.yaml'");
    expect(scrubA2aPaths("open '/data/sub/a2a.yaml'", ["/data"])).toBe("open 'sub/a2a.yaml'");
    expect(scrubA2aPaths("home is /data", ["/data"])).toBe("home is .");
  });
});

describe("pathForDisplay and a2aStatusView", () => {
  it("is relative inside the home and the file name outside it, never absolute", () => {
    expect(pathForDisplay("/data/a2a.yaml", "/data")).toBe("a2a.yaml");
    expect(pathForDisplay("/data/sub/a2a.yaml", "/data/")).toBe("sub/a2a.yaml");
    expect(pathForDisplay("/srv/data/a2a.yaml", "/data")).toBe("a2a.yaml");
    expect(pathForDisplay("/data2/a2a.yaml", "/data")).toBe("a2a.yaml");
    expect(pathForDisplay("/my proj/a2a.yaml", "/data")).toBe("a2a.yaml");
    expect(pathForDisplay("/Volumes/Sandisk SSD/proj/a2a.yaml", "/data")).toBe("a2a.yaml");
    expect(pathForDisplay("C:\\Users\\me\\proj\\a2a.yaml", "C:\\Users\\me\\.stageflow")).toBe("a2a.yaml");
    expect(pathForDisplay("C:\\Users\\me\\.stageflow\\a2a.yaml", "C:\\Users\\me\\.stageflow")).toBe("a2a.yaml");
  });

  it("leaves a status without a config path alone", () => {
    expect(a2aStatusView({ state: "disabled" as const }, "/data")).toEqual({ state: "disabled" });
    expect(a2aStatusView({ state: "enabled" as const, configPath: "/data/a2a.yaml" }, "/data", {})).toEqual({ state: "enabled", configPath: "a2a.yaml", configSource: "home" });
  });

  it("tells a project a2a.yaml from the home one and from STAGEFLOW_A2A_CONFIG", () => {
    expect(a2aStatusView({ configPath: "/data/a2a.yaml" }, "/data", {})).toEqual({ configPath: "a2a.yaml", configSource: "home" });
    expect(a2aStatusView({ configPath: "/srv/proj/a2a.yaml" }, "/data", {})).toEqual({ configPath: "a2a.yaml", configSource: "project" });
    expect(a2aStatusView({ configPath: "/etc/sf/a2a.yaml" }, "/data", { STAGEFLOW_A2A_CONFIG: "/etc/sf/a2a.yaml" })).toEqual({ configPath: "a2a.yaml", configSource: "override" });
    expect(a2aStatusView({ configPath: "/data2/a2a.yaml" }, "/data", {})).toEqual({ configPath: "a2a.yaml", configSource: "project" });
  });
});
