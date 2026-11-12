import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRail } from "./AppRail";

describe("AppRail experimental badge", () => {
  it("includes visually hidden experimental text on Exp", () => {
    const html = renderToStaticMarkup(
      <AppRail activeId="today" onNavigate={() => undefined} />,
    );
    expect(html).toContain('class="sr-only">experimental</span>');
    expect(html).toContain(">Exp</span>");
  });
});
