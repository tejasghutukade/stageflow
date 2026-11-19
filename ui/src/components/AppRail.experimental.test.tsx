import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NAV_GROUPS } from "../redesign/shell/navConfig";
import { AppRail } from "./AppRail";

function railItemHtml(html: string, id: string): string {
  const re = new RegExp(`<a[^>]*href="#/${id}"[^>]*>[\\s\\S]*?</a>`);
  const match = html.match(re);
  expect(match).toBeTruthy();
  return match![0];
}

describe("AppRail experimental badge", () => {
  it("shows Exp only on experimental nav items", () => {
    const html = renderToStaticMarkup(
      <AppRail activeId="today" onNavigate={() => undefined} />,
    );
    const identityItem = railItemHtml(html, "identity");
    const a2aItem = railItemHtml(html, "a2a");

    expect(identityItem).not.toContain('title="Experimental"');
    expect(identityItem).not.toContain(">Exp</span>");

    expect(a2aItem).toContain('title="Experimental"');
    expect(a2aItem).toContain('class="sr-only">experimental</span>');
    expect(a2aItem).toContain(">Exp</span>");
  });

  it("keeps Identity stable in the console nav and A2A experimental", () => {
    const items = NAV_GROUPS.flatMap((group) => group.items);
    const identity = items.find((item) => item.id === "identity");
    const a2a = items.find((item) => item.id === "a2a");
    expect(identity?.experimental).toBeFalsy();
    expect(a2a?.experimental).toBe(true);
  });
});