import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { CatalogRoot } from "../../api/types";
import { getSurfaceScope, setSurfaceScope, withSurfaceScope } from "../../api/projectScope";
import { OtherProjectsNote } from "./OtherProjectsNote";
import { countHiddenInOtherProjects, hiddenSummary } from "./otherProjects";

const root = (project_root: string, label = project_root, available = true): CatalogRoot => ({
  project_root,
  kind: "workspace",
  label,
  read_only: false,
  available,
});

const key = (item: { id: string }) => item.id;

describe("countHiddenInOtherProjects", () => {
  it("counts items other projects hold that the visible list does not, and skips empty projects", async () => {
    const lists: Record<string, Array<{ id: string }>> = {
      workspace: [{ id: "a" }],
      "/repo/demo": [{ id: "b" }, { id: "c" }],
      "/repo/empty": [],
      "/repo/down": [{ id: "z" }],
    };
    const hidden = await countHiddenInOtherProjects({
      roots: [root("workspace"), root("/repo/demo", "demo"), root("/repo/empty"), root("/repo/down", "down", false)],
      visible: [{ id: "a" }],
      load: async (r) => lists[r] ?? [],
      keyOf: key,
    });
    expect(hidden).toEqual([{ root: "/repo/demo", label: "demo", count: 2 }]);
    expect(hiddenSummary(hidden)).toBe("2 more in other projects");
  });

  it("ignores the scoped root and a root that fails to load", async () => {
    const hidden = await countHiddenInOtherProjects({
      roots: [root("workspace"), root("/repo/demo"), root("/repo/bad")],
      visible: [{ id: "b" }],
      scope: "/repo/demo",
      load: async (r) => {
        if (r === "/repo/bad") throw new Error("boom");
        return [{ id: "a" }];
      },
      keyOf: key,
    });
    expect(hidden).toEqual([{ root: "workspace", label: "workspace", count: 1 }]);
  });
});

describe("OtherProjectsNote", () => {
  const noop = () => {};
  it("renders nothing when nothing is hidden and no scope is set", () => {
    expect(renderToStaticMarkup(createElement(OtherProjectsNote, { hidden: [], onSwitch: noop, onReset: noop }))).toBe("");
  });
  it("shows the hidden count and one switch button per project", () => {
    const html = renderToStaticMarkup(
      createElement(OtherProjectsNote, {
        hidden: [{ root: "/repo/demo", label: "demo", count: 3 }],
        onSwitch: noop,
        onReset: noop,
      }),
    );
    expect(html).toContain("3 more in other projects");
    expect(html).toContain("demo (3)");
  });
  it("offers a way back while scoped", () => {
    const html = renderToStaticMarkup(
      createElement(OtherProjectsNote, { hidden: [], scopeLabel: "demo", onSwitch: noop, onReset: noop }),
    );
    expect(html).toContain("Showing only demo");
    expect(html).toContain("Back to the default project");
  });
});

describe("surface scope", () => {
  afterEach(() => setSurfaceScope("agents", undefined));
  it("appends project_root to requests only while a scope is set", () => {
    expect(withSurfaceScope("/api/agents", "agents")).toBe("/api/agents");
    setSurfaceScope("agents", "/repo/demo");
    expect(getSurfaceScope("agents")).toBe("/repo/demo");
    expect(withSurfaceScope("/api/agents", "agents")).toBe("/api/agents?project_root=%2Frepo%2Fdemo");
    expect(withSurfaceScope("/api/agents/x?limit=2", "agents")).toBe("/api/agents/x?limit=2&project_root=%2Frepo%2Fdemo");
    expect(withSurfaceScope("/api/agents?project_root=other", "agents")).toBe("/api/agents?project_root=other");
    expect(withSurfaceScope("/api/functions", "functions")).toBe("/api/functions");
  });
});
