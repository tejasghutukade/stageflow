import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import path from "node:path";
import { htmlLibraryDiskReadsForTests, htmlLibraryIntegrity, htmlLibraryPackageRoot, readHtmlLibraryFile, resetHtmlLibraryFileCacheForTests, resolveHtmlLibraryFile } from "../src/artifacts/library/htmlLibraryFiles.js";
import { HTML_LIBRARIES } from "../src/artifacts/library/htmlLibraries.js";
import { HTML_LIBRARY_FLAGS } from "../src/artifacts/library/htmlLibraryFlags.js";
import { buildLiveDocument, liveLibraryTags } from "../src/server/sandboxShell.js";

describe("vendored HTML libraries", () => {
  it("recomputes sha384 for every installed file", () => {
    expect(HTML_LIBRARIES.map((library) => library.name)).toEqual(["chartjs", "d3", "echarts", "leaflet", "mermaid"]);
    expect(HTML_LIBRARY_FLAGS).toEqual(
      HTML_LIBRARIES.map((library) => ({
        name: library.name,
        version: library.version,
        needsEval: library.needsEval,
        assets: library.assets,
      })),
    );
    for (const library of HTML_LIBRARIES) {
      let bytes = 0;
      for (const file of library.files) {
        const resolved = resolveHtmlLibraryFile(library, file);
        expect(resolved, `${library.name} ${file.path}`).toBeTruthy();
        const body = readFileSync(resolved!);
        bytes += body.length;
        expect(file.integrity, file.path).toBe(htmlLibraryIntegrity(body));
        expect(file.integrity.startsWith("sha384-")).toBe(true);
        const unpacked = path.join(htmlLibraryPackageRoot(), "node_modules", library.packageName, file.packageFile);
        expect(htmlLibraryIntegrity(readFileSync(unpacked)), file.packageFile).toBe(file.integrity);
      }
      expect(library.bytes).toBe(bytes);
    }
    expect(HTML_LIBRARIES.find((library) => library.name === "mermaid")?.needsEval).toBe(true);
    expect(HTML_LIBRARIES.filter((library) => library.name !== "mermaid").every((library) => library.needsEval === false)).toBe(true);
  });

  it("injects library tags with SRI before the bridge script", () => {
    const origin = "http://127.0.0.1:4311";
    const tags = liveLibraryTags([{ name: "chartjs", version: "4.6.2" }, { name: "leaflet", version: "1.9.4" }], origin);
    expect(tags).toContain(`src="${origin}/libs/chartjs@4.6.2/chart.umd.min.js"`);
    expect(tags).toContain('integrity="sha384-');
    expect(tags).toContain('crossorigin="anonymous"');
    expect(tags).toContain(`href="${origin}/libs/leaflet@1.9.4/leaflet.css"`);
    expect(tags).not.toContain("marker-icon.png");
    expect(liveLibraryTags([{ name: "chartjs", version: "9.9.9" }], origin)).toBeNull();
    const doc = buildLiveDocument("<p>ok</p>", "default-src 'none'", "bridge", [{ name: "chartjs", version: "4.6.2" }], origin);
    const cspAt = doc.indexOf("Content-Security-Policy");
    const libAt = doc.indexOf("/libs/chartjs@4.6.2/");
    const bridgeAt = doc.indexOf("bridge");
    const bodyAt = doc.indexOf("<body>");
    expect(cspAt).toBeGreaterThan(-1);
    expect(cspAt).toBeLessThan(libAt);
    expect(libAt).toBeLessThan(bridgeAt);
    expect(bridgeAt).toBeLessThan(bodyAt);
  });

  it("reads a library file from disk once and keeps the content type", () => {
    resetHtmlLibraryFileCacheForTests();
    const first = readHtmlLibraryFile("chartjs", "4.6.2", "chart.umd.min.js");
    expect(htmlLibraryDiskReadsForTests()).toBe(1);
    expect(first?.contentType).toBe("application/javascript");
    const second = readHtmlLibraryFile("chartjs", "4.6.2", "chart.umd.min.js");
    expect(htmlLibraryDiskReadsForTests()).toBe(1);
    expect(second).toBe(first);
    expect(second?.contentType).toBe("application/javascript");
    expect(readHtmlLibraryFile("chartjs", "4.6.2", "missing.js")).toBeNull();
  });
});
