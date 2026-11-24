import { describe, expect, it } from "vitest";
import {
  STATIC_HTML_CSP_META,
  STATIC_HTML_DOCUMENT_START,
  isHtmlPreviewPath,
  linkHrefIsExternal,
  prepareStaticHtml,
} from "./htmlSandbox";

const sample = [
  "<!DOCTYPE html>",
  "<html>",
  "<head><title>Report</title></head>",
  "<body>",
  "<p>héllo 你好</p>",
  "<script>document.title='pwned'</script>",
  '<meta http-equiv="refresh" content="0;url=https://evil.test/go">',
  '<base href="https://evil.test/">',
  '<link rel="stylesheet" href="app.css">',
  '<link rel="stylesheet" href="https://evil.test/a.css">',
  '<iframe src="https://evil.test/frame"></iframe>',
  "<object data=\"https://evil.test/obj\">fallback</object>",
  '<embed src="https://evil.test/a.swf">',
  "</body></html>",
].join("");

function expectCspMetaFirst(html: string): void {
  expect(html.startsWith(STATIC_HTML_DOCUMENT_START)).toBe(true);
  const headAt = html.indexOf("<head>");
  expect(html.slice(headAt + "<head>".length).startsWith(STATIC_HTML_CSP_META)).toBe(true);
  expect(html.indexOf(STATIC_HTML_CSP_META)).toBeLessThan(html.indexOf("</head>"));
}

describe("prepareStaticHtml", () => {
  it("puts the CSP meta first in head", () => {
    const out = prepareStaticHtml("<html><head><title>T</title></head><body></body></html>");
    expect(out).toBe(
      `${STATIC_HTML_DOCUMENT_START}<html><head><title>T</title></head><body></body></html>`,
    );
    expectCspMetaFirst(out);
    expect(out.indexOf(STATIC_HTML_CSP_META)).toBeLessThan(out.indexOf("<title>"));
  });

  it("opens a head when the document has none", () => {
    const fragment = prepareStaticHtml("<p>Hi</p>");
    expect(fragment).toBe(`${STATIC_HTML_DOCUMENT_START}<p>Hi</p>`);
    const withHtml = prepareStaticHtml("<html><body><p>Hi</p></body></html>");
    expect(withHtml).toBe(`${STATIC_HTML_DOCUMENT_START}<html><body><p>Hi</p></body></html>`);
  });

  it("keeps the CSP meta as the first head element for every document shape", () => {
    const cases = [
      `<textarea><head></textarea><img src=https://example.com/x.png>`,
      `<body><p>After</p><head><title>Late</title></head>`,
      `<p>no head</p>`,
      `<head><title>A</title></head><head><title>B</title></head>`,
      `<HEAD><TITLE>Upper</TITLE></HEAD>`,
      `<!DOCTYPE html><html><head><title>Doc</title></head><body><p>x</p></body></html>`,
    ];
    for (const input of cases) {
      const out = prepareStaticHtml(input);
      expectCspMetaFirst(out);
      expect(prepareStaticHtml(out)).toBe(out);
    }
    const stripped = prepareStaticHtml("<!DOCTYPE html><p>Hi</p>");
    expect(stripped).toBe(`${STATIC_HTML_DOCUMENT_START}<p>Hi</p>`);
    const publicDoctype = prepareStaticHtml('<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"><p>Hi</p>');
    expect(publicDoctype).toContain("<!DOCTYPE html PUBLIC");
  });

  it("leaves script tags in place", () => {
    const out = prepareStaticHtml(sample);
    expect(out).toContain("<script>document.title='pwned'</script>");
  });

  it("neutralises refresh, base, external links, frames, objects, and embeds", () => {
    const out = prepareStaticHtml(sample);
    expect(out).not.toContain("https://evil.test");
    expect(out).not.toContain("<base");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<object");
    expect(out).not.toContain("<embed");
    expect(out).not.toContain('http-equiv="refresh"');
    expect(out).toContain('href="app.css"');
    expect(out).toContain("fallback");
    expect(out).toContain("<p>héllo 你好</p>");
  });

  it("matches tags case-insensitively and keeps unicode text", () => {
    const out = prepareStaticHtml(
      [
        "<HEAD>",
        '<META HTTP-EQUIV="Refresh" content="0;url=https://evil.test/case">',
        '<BASE HREF="https://evil.test/base">',
        '<LINK REL="stylesheet" HREF="HTTPS://Evil.Test/a.css">',
        '<IFRAME SRC="https://evil.test/frame">inner</IFRAME>',
        '<OBJECT DATA="https://evil.test/obj"></OBJECT>',
        '<EMBED SRC="https://evil.test/a.swf">',
        "</HEAD>",
        "<p>café — 日本語</p>",
      ].join(""),
    );
    expect(out).not.toContain("evil.test");
    expect(out).not.toContain("Evil.Test");
    expect(out).toContain("café — 日本語");
    expect(out).toContain("inner");
    expectCspMetaFirst(out);
    expect(out).toContain("<HEAD>");
  });

  it("handles a large document in one pass", () => {
    const pad = "x".repeat(2_000_000);
    const out = prepareStaticHtml(`<head></head><p>${pad}</p><meta http-equiv="refresh" content="0;url=https://evil.test/big">`);
    expect(out.includes("https://evil.test/big")).toBe(false);
    expect(out.includes(STATIC_HTML_CSP_META)).toBe(true);
    expect(out.includes(pad)).toBe(true);
  });

  it("is idempotent", () => {
    const once = prepareStaticHtml(sample);
    expect(prepareStaticHtml(once)).toBe(once);
    const fragment = prepareStaticHtml("<p>Hi</p>");
    expect(prepareStaticHtml(fragment)).toBe(fragment);
  });

  it("does not rewrite tags inside comments or script text", () => {
    const out = prepareStaticHtml(
      '<!-- <meta http-equiv="refresh" content="0;url=https://comment.example/r"> --><script>const s = "<iframe src=\\"https://script.example\\"></iframe>";</script><meta http-equiv="refresh" content="0;url=https://live.example/r">',
    );
    expect(out).toContain("https://comment.example/r");
    expect(out).toContain("https://script.example");
    expect(out).not.toContain("https://live.example/r");
  });

  it("drops a refresh meta whose attributes are quoted either way", () => {
    const out = prepareStaticHtml(`<p>ok</p><meta content='0;url=https://evil.test/q' http-equiv='refresh'>`);
    expect(out).not.toContain("evil.test");
    expect(out).toContain("<p>ok</p>");
  });

  it("drops non-fragment href and ping on anchors and areas", () => {
    const out = prepareStaticHtml(
      [
        '<a href="https://example.com/x">Go</a>',
        "<a href='https://example.com/q'>Quoted</a>",
        "<a href=https://example.com/u>Bare</a>",
        '<A HREF="HTTPS://Example.com/c">Case</A>',
        '<a href="javascript&#58;alert(1)">Js</a>',
        '<a href="&#104;ttps://example.com/e">Entity</a>',
        '<a href=#top>Frag</a>',
        '<a href="#section" ping="https://example.com/p">Ping</a>',
        '<a href="https://example.com/t" title="Already">Titled</a>',
        '<area href="https://example.com/map" alt="spot">',
        '<form action="https://example.com/post"><button>Send</button></form>',
      ].join(""),
    );
    expect(out).toContain('<a title="Link disabled in static preview">Go</a>');
    expect(out).toContain('<a title="Link disabled in static preview">Quoted</a>');
    expect(out).toContain('<a title="Link disabled in static preview">Bare</a>');
    expect(out).toContain('<a title="Link disabled in static preview">Case</A>');
    expect(out).toContain('<a title="Link disabled in static preview">Js</a>');
    expect(out).toContain('<a title="Link disabled in static preview">Entity</a>');
    expect(out).toContain("<a href=#top>Frag</a>");
    expect(out).toContain('<a href="#section">Ping</a>');
    expect(out).not.toContain("ping=");
    expect(out).toContain('<a title="Already">Titled</a>');
    expect(out).toContain('<area alt="spot" title="Link disabled in static preview">');
    expect(out).toContain('action="https://example.com/post"');
    expect(out).not.toContain("example.com/x");
    expect(out).not.toContain("javascript&#58;");
    expect(prepareStaticHtml(out)).toBe(out);
  });

  it("ends comments where the browser does and still neutralises the next tag", () => {
    const abrupt = prepareStaticHtml('<!--><a href="https://example.com/cmt1">x</a>');
    expect(abrupt).toContain("<!-->");
    expect(abrupt).toContain('<a title="Link disabled in static preview">x</a>');
    expect(abrupt).not.toContain("example.com/cmt1");

    const abruptDash = prepareStaticHtml('<!---> <a href="https://example.com/cmt2">x</a>');
    expect(abruptDash).toContain("<!--->");
    expect(abruptDash).not.toContain("example.com/cmt2");

    const bang = prepareStaticHtml(
      '<!-- keep https://example.com/in-bang --!><a href="https://example.com/after-bang">x</a>',
    );
    expect(bang).toContain("https://example.com/in-bang");
    expect(bang).not.toContain("example.com/after-bang");

    const nested = prepareStaticHtml(
      '<!-- <!-- <a href="https://example.com/nested">x</a> --> <a href="https://example.com/after-nested">y</a>',
    );
    expect(nested).toContain("https://example.com/nested");
    expect(nested).not.toContain("example.com/after-nested");

    const bogus = prepareStaticHtml('<!x><a href="https://example.com/bogus">z</a>');
    expect(bogus).toContain("<!x>");
    expect(bogus).not.toContain("example.com/bogus");

    const pi = prepareStaticHtml('<?php echo 1; ?><a href="https://example.com/php">z</a>');
    expect(pi).toContain("<?php echo 1; ?>");
    expect(pi).not.toContain("example.com/php");

    const cdata = prepareStaticHtml(
      '<![CDATA[ <a href="https://example.com/cdata-in"> ]]><a href="https://example.com/cdata-out">z</a>',
    );
    expect(cdata).toContain("https://example.com/cdata-in");
    expect(cdata).not.toContain("example.com/cdata-out");

    const endSpace = prepareStaticHtml('</ a><a href="https://example.com/after-space">z</a>');
    expect(endSpace).toContain("</ a>");
    expect(endSpace).not.toContain("example.com/after-space");

    const endDigit = prepareStaticHtml('</3><a href="https://example.com/after-3">z</a>');
    expect(endDigit).not.toContain("example.com/after-3");

    const endInner = prepareStaticHtml(
      '</ <a href="https://example.com/bogus-end">x</a> ><a href="https://example.com/after-bogus-end">y</a>',
    );
    expect(endInner).toContain("https://example.com/bogus-end");
    expect(endInner).not.toContain("example.com/after-bogus-end");
  });

  it("leaves raw text and RCDATA alone and neutralises the following tag", () => {
    const cases = [
      ["script", "in-script", "after-script"],
      ["style", "in-style", "after-style"],
      ["textarea", "in-textarea", "after-textarea"],
      ["title", "in-title", "after-title"],
    ] as const;
    for (const [tag, inside, after] of cases) {
      const out = prepareStaticHtml(
        `<${tag}><a href="https://example.com/${inside}">x</a></${tag.toUpperCase()}><a href="https://example.com/${after}">y</a>`,
      );
      expect(out).toContain(`https://example.com/${inside}`);
      expect(out).not.toContain(`example.com/${after}`);
    }
  });

  it("strips svg link destinations and keeps fragments", () => {
    const out = prepareStaticHtml(
      [
        '<svg><a xlink:href="https://example.com/svg1">t</a></svg>',
        '<svg><a XLINK:HREF="https://example.com/svg2">t</a></svg>',
        '<area xlink:href="https://example.com/area1" alt="spot">',
        '<svg><use href="https://example.com/use1" xlink:href="https://example.com/use2"/></svg>',
        '<svg><image href="https://example.com/img1"></image></svg>',
        '<svg><feImage xlink:href="https://example.com/fe1"></feImage></svg>',
        '<svg><script href="https://example.com/scr1" xlink:href="https://example.com/scr2"></script></svg>',
        '<script href="https://example.com/htmlscr"></script>',
        '<a xlink:href="#frag">f</a>',
        '<use href="#icon"></use>',
        '<a href="#top" xlink:href="https://example.com/mix">m</a>',
      ].join(""),
    );
    expect(out).not.toContain("example.com/svg1");
    expect(out).not.toContain("example.com/svg2");
    expect(out).not.toContain("example.com/area1");
    expect(out).not.toContain("example.com/use1");
    expect(out).not.toContain("example.com/use2");
    expect(out).not.toContain("example.com/img1");
    expect(out).not.toContain("example.com/fe1");
    expect(out).not.toContain("example.com/scr1");
    expect(out).not.toContain("example.com/scr2");
    expect(out).toContain("https://example.com/htmlscr");
    expect(out).toContain('<a xlink:href="#frag">f</a>');
    expect(out).toContain('<use href="#icon"></use>');
    expect(out).toContain('href="#top"');
    expect(out).not.toContain("example.com/mix");
    expect(out).toContain('<area alt="spot" title="Link disabled in static preview">');
    expect(prepareStaticHtml(out)).toBe(out);
  });

  it("finishes hostile unterminated input in linear time", () => {
    const units = ["<a ", "</a x=", '<a href="', "<!--", "<a href=x ", "<", "<!x"];
    const timings: Record<string, number> = {};
    for (const unit of units) {
      const input = unit.repeat(Math.ceil(2_000_000 / unit.length));
      expect(input.length).toBeGreaterThanOrEqual(2_000_000);
      const started = performance.now();
      const out = prepareStaticHtml(input);
      const elapsed = performance.now() - started;
      timings[unit] = elapsed;
      expect(out.startsWith(STATIC_HTML_DOCUMENT_START)).toBe(true);
      expect(out.endsWith(input)).toBe(true);
      expect(elapsed).toBeLessThan(1500);
    }
    const unit = "<a ";
    prepareStaticHtml(unit.repeat(1000));
    const small = unit.repeat(Math.ceil(250_000 / unit.length));
    const large = unit.repeat(Math.ceil(1_000_000 / unit.length));
    const bestOf = (input: string) => {
      let best = Infinity;
      for (let run = 0; run < 5; run += 1) {
        const started = performance.now();
        prepareStaticHtml(input);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const smallMs = bestOf(small);
    const largeMs = bestOf(large);
    timings["250KB <a "] = smallMs;
    timings["1MB <a "] = largeMs;
    console.info("hostile html timings ms", timings);
    expect(largeMs).toBeLessThan(smallMs * 10 + 5);
  });
});

describe("linkHrefIsExternal", () => {
  it("treats hosts and protocol-relative urls as external and leaves relative and data urls", () => {
    expect(linkHrefIsExternal("https://evil.test/a.css")).toBe(true);
    expect(linkHrefIsExternal("//evil.test/a.css")).toBe(true);
    expect(linkHrefIsExternal("app.css")).toBe(false);
    expect(linkHrefIsExternal("data:text/css,p{color:red}")).toBe(false);
  });
});

describe("isHtmlPreviewPath", () => {
  it("matches html and htm names only", () => {
    expect(isHtmlPreviewPath("stages/a/attempts/1/artifacts/page.html")).toBe(true);
    expect(isHtmlPreviewPath("Page.HTM")).toBe(true);
    expect(isHtmlPreviewPath("file.xhtml")).toBe(false);
    expect(isHtmlPreviewPath("file.html.txt")).toBe(false);
    expect(isHtmlPreviewPath("notes.md")).toBe(false);
  });
});
