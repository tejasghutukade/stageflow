import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ControlTokenInstructions } from "./ControlTokenGate";

describe("ControlTokenInstructions", () => {
  it("renders cat <path> when the hint names a file", () => {
    const html = renderToStaticMarkup(
      createElement(ControlTokenInstructions, {
        hint: { tokenFile: "/data/control-token" },
      }),
    );
    expect(html).toContain("cat /data/control-token");
    expect(html).not.toContain("docker logs");
  });

  it("renders the fallback when the hint is null", () => {
    const html = renderToStaticMarkup(
      createElement(ControlTokenInstructions, { hint: null }),
    );
    expect(html).toContain("docker exec &lt;container&gt; cat /data/control-token");
    expect(html).toContain("~/.stageflow");
    expect(html).not.toContain("docker logs");
  });
});
