import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { memoryCardReadPath } from "../../api";
import { MemoriesPage } from "./MemoriesPage";

const KEY = "../odd key/%2F..";

describe("memories page cards", () => {
  it("puts the card key in the query string and decodes it once", () => {
    const read = memoryCardReadPath("pool", KEY);
    const previous = memoryCardReadPath("pool", KEY, true);
    const readUrl = new URL(read, "http://local");
    const previousUrl = new URL(previous, "http://local");
    expect(readUrl.pathname).toBe("/api/memories/pool/cards");
    expect(previousUrl.pathname).toBe("/api/memories/pool/cards/previous");
    expect(readUrl.searchParams.get("key")).toBe(KEY);
    expect(previousUrl.searchParams.get("key")).toBe(KEY);
  });

  it("renders the key list, open card, previous copies, and cover editor", () => {
    const html = renderToStaticMarkup(createElement(MemoriesPage, {
      memoryId: "pool",
      loaded: {
        detail: { id: "pool", description: "People already sourced.", body: "new cover" },
        previousCover: "old cover",
        keys: [KEY, "ada@example.com"],
        card: { key: KEY, body: "shortlisted", previous: "sourced" },
      },
    }));
    expect(html).toContain('data-testid="memory-card-key"');
    expect(html).toContain(KEY);
    expect(html).toContain("ada@example.com");
    expect(html).toContain('data-testid="memory-open-card"');
    expect(html).toContain("shortlisted");
    expect(html).toContain('data-testid="memory-previous-card"');
    expect(html).toContain("sourced");
    expect(html).toContain('data-testid="memory-previous-cover"');
    expect(html).toContain("old cover");
    expect(html).toContain('data-testid="memory-cover"');
    expect(html).toContain("new cover");
    expect(html).toContain("Save cover");
    expect(html).toContain("Save card");
    expect(html).toContain("Delete");
  });

  it("hides previous cover and previous card when there is no earlier copy", () => {
    const html = renderToStaticMarkup(createElement(MemoriesPage, {
      memoryId: "pool",
      loaded: {
        detail: { id: "pool", description: "People already sourced.", body: "only cover" },
        previousCover: null,
        keys: ["ada@example.com"],
        card: { key: "ada@example.com", body: "sourced", previous: null },
      },
    }));
    expect(html).not.toContain('data-testid="memory-previous-cover"');
    expect(html).not.toContain('data-testid="memory-previous-card"');
    expect(html).toContain('data-testid="memory-cover"');
    expect(html).toContain("sourced");
  });
});
