import { describe, expect, it } from "vitest";
import { scrubA2aPaths } from "../src/a2a/errorText.js";

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
