import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { startSandboxListener } from "../src/server/sandboxListener.js";
import { artifactDocumentCsp } from "../src/server/sandboxShell.js";

const declaredCsp = artifactDocumentCsp({
  connectDomains: ["https://allowed.example.test"],
  resourceDomains: ["https://cdn.example.test"],
  frameDomains: [],
});
const emptyCsp = artifactDocumentCsp({});

type Violation = { violated?: string; effective?: string; blocked?: string };
type Capture = { events?: Violation[]; error?: string | null; ok?: boolean };

function artifactHtml(kind: "declared" | "empty", hostOrigin: string): string {
  return `<!doctype html><html><body>
<a id="lnk" href="https://example.com/out" target="_blank">out</a>
<a id="hash" href="#sec">local</a>
<div id="sec"></div>
<div id="wide" style="width:9000px;height:700px;display:inline-block;white-space:nowrap"></div>
<a id="topLink" href="#top">top</a>
<a id="bare" href="#">bare</a>
<form id="f" action="https://example.com/post" method="post"><button type="submit">go</button></form>
<script>
var KIND = ${JSON.stringify(kind)};
var hostOrigin = ${JSON.stringify(hostOrigin)};
var report = { kind: KIND, probes: {}, checks: {} };
window.__sfStay = 1;
function pack(event) {
  return { violated: event.violatedDirective, effective: event.effectiveDirective, blocked: event.blockedURI };
}
function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
function watch(work, settleMs) {
  var events = [];
  function onEvent(event) { events.push(pack(event)); }
  document.addEventListener("securitypolicyviolation", onEvent);
  var outcome = work();
  var settled = outcome && typeof outcome.then === "function"
    ? outcome.then(function (value) { return value; }, function (error) { return { error: error && error.name }; })
    : Promise.resolve(outcome || {});
  return settled.then(function (value) {
    return wait(settleMs == null ? 80 : settleMs).then(function () {
      document.removeEventListener("securitypolicyviolation", onEvent);
      var result = value || {};
      result.events = events;
      return result;
    });
  });
}
function fetchCheck(url) {
  return watch(function () {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve({ error: "timeout" }); }, 8000);
      fetch(url).then(function () {
        clearTimeout(timer);
        resolve({ error: null, ok: true });
      }, function (error) {
        clearTimeout(timer);
        resolve({ error: error && error.name });
      });
    });
  }, 50);
}
function elementCheck(create) {
  return new Promise(function (resolve) {
    var events = [];
    var done = false;
    function onEvent(event) {
      events.push(pack(event));
      setTimeout(finish, 40);
    }
    document.addEventListener("securitypolicyviolation", onEvent);
    var el = create();
    var timer = setTimeout(finish, 8000);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      document.removeEventListener("securitypolicyviolation", onEvent);
      resolve({ events: events });
    }
    el.onload = function () { setTimeout(finish, 40); };
    el.onerror = function () { setTimeout(finish, 40); };
  });
}
function trap(name, fn) {
  try { report.probes[name] = String(fn()); }
  catch (error) { report.probes[name] = error.name; }
}
function stayed(hrefBefore) {
  return {
    href: String(location.href),
    same: String(location.href) === hrefBefore,
    sentinel: window.__sfStay === 1,
    about: String(location.href).indexOf("about:") === 0
  };
}
function attempt(name, fn) {
  var hrefBefore = String(location.href);
  var events = [];
  function onEvent(event) { events.push(pack(event)); }
  document.addEventListener("securitypolicyviolation", onEvent);
  var thrown = null;
  try { fn(); }
  catch (error) { thrown = error && error.name ? error.name : "throw"; }
  return wait(400).then(function () {
    document.removeEventListener("securitypolicyviolation", onEvent);
    var stay = stayed(hrefBefore);
    stay.name = name;
    stay.thrown = thrown;
    stay.events = events;
    return stay;
  });
}
function navBattery() {
  var steps = [
    ["href", function () { location.href = "https://example.com/"; }],
    ["assign", function () { location.assign("https://example.com/"); }],
    ["replace", function () { location.replace("https://example.com/"); }],
    ["windowLocation", function () { window.location = "https://example.com/"; }],
    ["documentLocation", function () { document.location = "https://example.com/"; }],
    ["anchorClick", function () {
      var anchor = document.createElement("a");
      anchor.href = "https://example.com/";
      document.body.appendChild(anchor);
      anchor.click();
    }],
    ["metaRefresh", function () {
      var meta = document.createElement("meta");
      meta.httpEquiv = "refresh";
      meta.content = "0;url=https://example.com/";
      document.head.appendChild(meta);
    }],
    ["formSubmit", function () {
      var form = document.createElement("form");
      form.action = "https://example.com/post";
      form.method = "post";
      document.body.appendChild(form);
      form.submit();
    }],
    ["formRequestSubmit", function () { document.getElementById("f").requestSubmit(); }],
    ["windowOpen", function () { window.open("https://example.com/"); }]
  ];
  var attempts = [];
  var chain = Promise.resolve();
  steps.forEach(function (step) {
    chain = chain.then(function () {
      return attempt(step[0], step[1]).then(function (result) { attempts.push(result); });
    });
  });
  return chain.then(function () {
    return watch(function () {
      var link = document.createElement("link");
      link.rel = "dns-prefetch";
      link.href = "https://dns.example.test/";
      document.head.appendChild(link);
      return {};
    }, 200).then(function (dns) {
      report.checks.dns = dns;
      report.checks.navigation = {
        attempts: attempts,
        sentinel: window.__sfStay === 1,
        href: String(location.href)
      };
    });
  });
}
function ping() {
  return new Promise(function (resolve) {
    var id = 9001;
    var done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve(ok === true && window.__sfStay === 1);
    }
    function onMessage(event) {
      var message = event.data;
      if (!message || message.id !== id) return;
      finish(message.error === undefined && message.result !== undefined);
    }
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ jsonrpc: "2.0", id: id, method: "ping" }, "*");
    setTimeout(function () { finish(false); }, 1000);
  });
}
function finish() {
  window.stageflow.callBinding("probe.log", report).catch(function () {});
}
window.stageflow.initialize().then(function (ctx) {
  report.init = !!(ctx && ctx.platform === "web" && ctx.theme === "dark");
  trap("parentDocument", function () { return parent.document.title; });
  trap("topLocation", function () { return window.top.location.href; });
  trap("localStorage", function () { localStorage.setItem("k", "v"); return "set"; });
  trap("cookie", function () { return document.cookie; });
  trap("open", function () { var opened = window.open("https://example.com/"); return opened ? "opened" : "null"; });
  var chain = Promise.resolve();
  if (KIND === "empty") {
    chain = fetchCheck("https://allowed.example.test/x").then(function (result) {
      report.checks.connect = result;
      return elementCheck(function () {
        var img = document.createElement("img");
        img.src = "https://cdn.example.test/a.png";
        document.body.appendChild(img);
        return img;
      });
    }).then(function (result) {
      report.checks.img = result;
      return elementCheck(function () {
        var script = document.createElement("script");
        script.src = "https://cdn.example.test/a.js";
        document.head.appendChild(script);
        return script;
      });
    }).then(function (result) {
      report.checks.script = result;
      return elementCheck(function () {
        var frame = document.createElement("iframe");
        frame.src = "https://cdn.example.test/frame";
        document.body.appendChild(frame);
        return frame;
      });
    }).then(function (result) {
      report.checks.frame = result;
    });
  } else {
    chain = fetchCheck("https://allowed.example.test/x").then(function (result) {
      report.checks.allowedFetch = result;
      return fetchCheck("https://other.example.test/x");
    }).then(function (result) {
      report.checks.blockedFetch = result;
      return fetchCheck(hostOrigin + "/api/health");
    }).then(function (result) {
      report.probes.fetchConsole = result.error;
      return fetchCheck("https://example.com/");
    }).then(function (result) {
      report.probes.fetchExample = result.error;
      return elementCheck(function () {
        var script = document.createElement("script");
        script.src = "https://cdn.example.test/a.js";
        document.head.appendChild(script);
        return script;
      });
    }).then(function (result) {
      report.checks.scriptOk = result;
      return elementCheck(function () {
        var script = document.createElement("script");
        script.src = "https://evil.example.test/a.js";
        document.head.appendChild(script);
        return script;
      });
    }).then(function (result) {
      report.checks.scriptBad = result;
      return elementCheck(function () {
        var img = document.createElement("img");
        img.src = "https://cdn.example.test/a.png";
        document.body.appendChild(img);
        return img;
      });
    }).then(function (result) {
      report.checks.imgOk = result;
      return elementCheck(function () {
        var img = document.createElement("img");
        img.src = "https://evil.example.test/a.png";
        document.body.appendChild(img);
        return img;
      });
    }).then(function (result) {
      report.checks.imgBad = result;
      return elementCheck(function () {
        var frame = document.createElement("iframe");
        frame.src = "https://anywhere.example.test/x";
        document.body.appendChild(frame);
        return frame;
      });
    }).then(function (result) {
      report.checks.frame = result;
      return watch(function () {
        try { var socket = new WebSocket("wss://other.example.test"); socket.close(); return { error: null }; }
        catch (error) { return { error: error.name }; }
      }, 800);
    }).then(function (result) {
      report.checks.websocket = result;
      return watch(function () {
        var base = document.createElement("base");
        base.href = "https://x.example.test/";
        document.head.appendChild(base);
        return {};
      }, 400);
    }).then(function (result) {
      report.checks.base = result;
      return watch(function () {
        var link = document.createElement("link");
        link.rel = "dns-prefetch";
        link.href = "https://dns.example.test/";
        document.head.appendChild(link);
        return {};
      }, 200);
    }).then(function (result) {
      report.checks.dns = result;
      return watch(function () {
        var hrefBefore = String(location.href);
        try { document.getElementById("f").requestSubmit(); report.probes.form = "submitted"; }
        catch (error) { report.probes.form = error.name; }
        var form = document.createElement("form");
        form.action = "https://example.com/post";
        form.method = "post";
        document.body.appendChild(form);
        try { form.submit(); report.probes.formSubmit = "submitted"; }
        catch (error) { report.probes.formSubmit = error.name; }
        return wait(200).then(function () {
          return { hrefBefore: hrefBefore, hrefAfter: String(location.href), sentinel: window.__sfStay === 1 };
        });
      }, 20);
    }).then(function (result) {
      report.checks.form = result;
    });
  }
  return chain.then(function () {
    if (KIND === "declared") {
      var scrolled = [];
      var into = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function () {
        scrolled.push(this.id || this.getAttribute("name") || "element");
        return into.apply(this, arguments);
      };
      var to = window.scrollTo;
      window.scrollTo = function () {
        scrolled.push("top");
        return to.apply(this, arguments);
      };
      document.getElementById("hash").click();
      document.getElementById("topLink").click();
      document.getElementById("bare").click();
      report.hash = { scrolled: scrolled, href: String(location.href), stay: window.__sfStay === 1 };
      document.getElementById("lnk").click();
    }
    return window.stageflow.callBinding("probe.log", { "img-element": 1 }).catch(function (error) {
      report.invalidArg = { code: error && error.code, message: error && error.message };
    }).then(function () {
      return window.stageflow.callBinding("probe.log", report);
    });
  }, function (error) {
    report.failed = String(error && error.name || error);
    finish();
  });
}).catch(function (error) {
  report.failed = String(error && error.name || error);
  try { finish(); } catch (ignore) {}
});
</script>
</body></html>`;
}

function page(sandboxOrigin: string, hostOrigin: string): string {
  const declaredSrc = `${sandboxOrigin}/shell.html?parent=${encodeURIComponent(hostOrigin)}`;
  const emptySrc = `${sandboxOrigin}/shell.html?parent=${encodeURIComponent(hostOrigin)}`;
  const declaredHtml = JSON.stringify(artifactHtml("declared", hostOrigin)).replace(/</g, "\\u003c");
  const emptyHtml = JSON.stringify(artifactHtml("empty", hostOrigin)).replace(/</g, "\\u003c");
  const sink = (name: string) => `${hostOrigin}/nav-sink/${name}`;
  const navCases = [
    ["href", `location.href = ${JSON.stringify(sink("href"))};`],
    ["assign", `location.assign(${JSON.stringify(sink("assign"))});`],
    ["replace", `location.replace(${JSON.stringify(sink("replace"))});`],
    ["windowLocation", `window.location = ${JSON.stringify(sink("windowLocation"))};`],
    ["documentLocation", `document.location = ${JSON.stringify(sink("documentLocation"))};`],
    ["anchorClick", `var anchor = document.createElement("a"); anchor.href = "https://example.com/"; document.body.appendChild(anchor); anchor.click();`],
    ["metaRefresh", `var meta = document.createElement("meta"); meta.httpEquiv = "refresh"; meta.content = ${JSON.stringify(`0;url=${sink("metaRefresh")}`)}; document.head.appendChild(meta);`],
    ["formSubmit", `var form = document.createElement("form"); form.action = "https://example.com/post"; form.method = "post"; document.body.appendChild(form); form.submit();`],
    ["formRequestSubmit", `var form = document.createElement("form"); form.action = "https://example.com/post"; form.method = "post"; document.body.appendChild(form); form.requestSubmit();`],
    ["windowOpen", `var opened = window.open("https://example.com/"); window.__sfOpened = opened ? "opened" : "null";`],
  ] as const;
  const navJson = JSON.stringify(navCases.map(([name, action], index) => ({
    name,
    nonce: (index + 3).toString(16).padStart(32, "0"),
    html: `<!doctype html><body><script>
window.__sfStay = 1;
var events = [];
document.addEventListener("securitypolicyviolation", function (event) {
  events.push({ violated: event.violatedDirective, effective: event.effectiveDirective, blocked: event.blockedURI });
});
function ping() {
  return new Promise(function (resolve) {
    var id = 9001;
    function onMessage(event) {
      var message = event.data;
      if (!message || message.id !== id) return;
      window.removeEventListener("message", onMessage);
      resolve(message.error === undefined && message.result !== undefined);
    }
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ jsonrpc: "2.0", id: id, method: "ping" }, "*");
    setTimeout(function () { resolve(false); }, 800);
  });
}
window.stageflow.initialize().then(function () {
  var thrown = null;
  try { ${action} } catch (error) { thrown = error && error.name; }
  setTimeout(function () {
    ping().then(function (ok) {
      window.stageflow.callBinding("nav.log", {
        href: String(location.href),
        sentinel: window.__sfStay === 1,
        thrown: thrown,
        ping: ok === true,
        opened: window.__sfOpened || null,
        events: events
      });
    });
  }, 600);
}).catch(function () {});
</script></body>`,
  }))).replace(/</g, "\\u003c");
  return `<!doctype html><meta charset="utf-8"><pre id="out">pending</pre>
<iframe id="declared" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" src="${declaredSrc}"></iframe>
<iframe id="empty" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" src="${emptySrc}"></iframe>
<iframe id="attacker" src="/attacker.html"></iframe>
<script>
const sandboxOrigin = ${JSON.stringify(sandboxOrigin)};
const hostOrigin = ${JSON.stringify(hostOrigin)};
const navCases = ${navJson};
const sessions = {
  declared: { el: document.getElementById("declared"), nonce: "ab".repeat(16), html: ${declaredHtml}, csp: ${JSON.stringify(declaredCsp)}, loaded: false },
  empty: { el: document.getElementById("empty"), nonce: "cd".repeat(16), html: ${emptyHtml}, csp: ${JSON.stringify(emptyCsp)}, loaded: false }
};
for (const item of navCases) {
  const el = document.createElement("iframe");
  el.id = "nav-" + item.name;
  el.setAttribute("sandbox", "allow-scripts allow-same-origin");
  el.setAttribute("referrerpolicy", "no-referrer");
  el.src = sandboxOrigin + "/shell.html?parent=" + encodeURIComponent(hostOrigin);
  document.body.appendChild(el);
  sessions["nav-" + item.name] = { el: el, nonce: item.nonce, html: item.html, csp: ${JSON.stringify(declaredCsp)}, loaded: false, nav: item.name };
}
const reports = { nav: {} };
const seen = [];
let posted = false;
function sessionFor(source) {
  for (const kind of Object.keys(sessions)) {
    if (source === sessions[kind].el.contentWindow) return [kind, sessions[kind]];
  }
  return null;
}
function reply(session, message) {
  if (!session.el.contentWindow) return;
  session.el.contentWindow.postMessage({
    jsonrpc: "2.0",
    method: "sf/sandbox-relay",
    params: { nonce: session.nonce, message }
  }, sandboxOrigin);
}
function navSettled() {
  return navCases.every(function (item) {
    if (reports.nav[item.name]) return true;
    return seen.some(function (entry) { return entry.kind === "nav-" + item.name && entry.method === "sf/sandbox-error"; });
  });
}
function publish() {
  if (posted) return;
  if (!reports.declared || !reports.empty || !navSettled()) return;
  posted = true;
  const shellSrcs = { declared: sessions.declared.el.src };
  for (const item of navCases) shellSrcs[item.name] = sessions["nav-" + item.name].el.src;
  const body = JSON.stringify({ reports, seen, hostUrl: location.href, hostStart: hostOrigin + "/", shellSrc: sessions.declared.el.src, shellSrcs });
  document.getElementById("out").textContent = body;
  fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body });
}
window.addEventListener("message", (event) => {
  const found = sessionFor(event.source);
  const fromShell = found && event.origin === sandboxOrigin;
  if (!fromShell) {
    seen.push({ ignored: true, origin: String(event.origin), method: event.data && event.data.method });
    return;
  }
  const [kind, session] = found;
  const data = event.data;
  if (!data || data.jsonrpc !== "2.0") return;
  if (data.method === "sf/sandbox-error") {
    seen.push({ method: "sf/sandbox-error", kind, params: data.params, elapsed: Date.now() - (session.loadedAt || Date.now()) });
    publish();
    return;
  }
  if (data.method === "sf/sandbox-ready" && !session.loaded) {
    session.loaded = true;
    session.loadedAt = Date.now();
    session.el.contentWindow.postMessage({
      jsonrpc: "2.0",
      method: "sf/sandbox-load",
      params: { html: session.html, csp: session.csp, nonce: session.nonce }
    }, sandboxOrigin);
    return;
  }
  if (data.method !== "sf/sandbox-relay" || !data.params || data.params.nonce !== session.nonce) return;
  const message = data.params.message;
  seen.push({ kind, method: message.method, id: message.id, params: message.params });
  if (message.method === "ui/initialize") {
    reply(session, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "stageflow", version: "0" },
        hostCapabilities: { tools: { call: true }, sandbox: { permissions: {}, csp: session.csp } },
        hostContext: {
          theme: "dark",
          styles: { variables: { "--sf-ground": "#0c0d0f", "--sf-text-1": "#ecedee" } },
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          containerDimensions: {},
          platform: "web"
        }
      }
    });
  }
  if (message.method === "ping") {
    reply(session, { jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/call" && message.params && message.params.name === "probe.log") {
    reports[kind] = message.params.arguments || {};
    publish();
    reply(session, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: "{}" }],
        structuredContent: { ok: true },
        isError: false,
        _meta: { source: "cache", fetched_at: "2026-11-25T00:00:00.000Z" }
      }
    });
  }
  if (message.method === "tools/call" && message.params && message.params.name === "nav.log") {
    reports.nav[session.nav] = message.params.arguments || {};
    publish();
    reply(session, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: "{}" }],
        structuredContent: { ok: true },
        isError: false,
        _meta: { source: "cache", fetched_at: "2026-11-25T00:00:00.000Z" }
      }
    });
  }
});
setTimeout(() => {
  document.getElementById("attacker").contentWindow.postMessage({ fire: true }, hostOrigin);
}, 2500);
setTimeout(() => {
  if (posted) return;
  posted = true;
  const body = JSON.stringify({ reports, seen, hostUrl: location.href, hostStart: hostOrigin + "/", shellSrc: sessions.declared.el.src, timedOut: true });
  document.getElementById("out").textContent = body;
  fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body });
}, 50000);
</script>`;
}
const attacker = `<!doctype html><script>
window.addEventListener("message", function () {
  var shell = parent.document.getElementById("declared");
  shell.contentWindow.postMessage({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "probe.log", arguments: { injected: true } } }, "*");
  parent.postMessage({ jsonrpc: "2.0", id: 98, method: "ui/initialize", params: { injected: true } }, "*");
});
</script>`;

type Seen = {
  ignored?: boolean;
  kind?: string;
  method?: string;
  origin?: string;
  elapsed?: number;
  params?: { href?: string; reason?: string };
};
type NavResult = { href?: string; sentinel?: boolean; thrown?: string | null; ping?: boolean; opened?: string | null; events?: Violation[] };
type ReportBody = {
  reports?: { declared?: ProbeReport; empty?: ProbeReport; nav?: Record<string, NavResult> };
  seen?: Seen[];
  hostUrl?: string;
  hostStart?: string;
  shellSrc?: string;
  shellSrcs?: Record<string, string>;
  timedOut?: boolean;
};
type ProbeReport = {
  init?: boolean;
  failed?: string;
  hash?: { scrolled?: string[]; href?: string; stay?: boolean };
  probes?: Record<string, string>;
  checks?: Record<string, Capture & { hrefBefore?: string; hrefAfter?: string; sentinel?: boolean; attempts?: NavAttempt[]; ping?: boolean; href?: string }>;
};

function matches(value: string | undefined, name: string): boolean {
  if (!value) return false;
  return value === name || value.startsWith(`${name}-`) || value.startsWith(`${name} `);
}

function directed(capture: Capture | undefined, name: string): boolean {
  return (capture?.events ?? []).some((event) => matches(event.violated, name) || matches(event.effective, name));
}

function quiet(capture: Capture | undefined): boolean {
  return (capture?.events ?? []).length === 0;
}

function score(body: ReportBody, navRequests: readonly string[]): Array<{ name: string; pass: boolean; detail: string }> {
  const declared = body.reports?.declared;
  const empty = body.reports?.empty;
  const seen = body.seen ?? [];
  const checks = declared?.checks ?? {};
  const probes = declared?.probes ?? {};
  const lines: Array<{ name: string; pass: boolean; detail: string }> = [];
  const add = (name: string, pass: boolean, detail: string) => lines.push({ name, pass, detail });
  add(
    "1 allowed fetch has no violation",
    checks.allowedFetch?.error === "TypeError" && quiet(checks.allowedFetch),
    `error=${checks.allowedFetch?.error ?? "missing"} events=${checks.allowedFetch?.events?.length ?? "missing"}`,
  );
  add(
    "2 blocked fetch violates connect-src",
    checks.blockedFetch?.error === "TypeError" && directed(checks.blockedFetch, "connect-src"),
    `error=${checks.blockedFetch?.error ?? "missing"} events=${JSON.stringify(checks.blockedFetch?.events ?? [])}`,
  );
  add(
    "3 script src allows the declared host and blocks the other",
    quiet(checks.scriptOk) && directed(checks.scriptBad, "script-src"),
    `ok=${JSON.stringify(checks.scriptOk?.events ?? null)} bad=${JSON.stringify(checks.scriptBad?.events ?? null)}`,
  );
  add(
    "4 img src allows the declared host and blocks the other",
    quiet(checks.imgOk) && directed(checks.imgBad, "img-src"),
    `ok=${JSON.stringify(checks.imgOk?.events ?? null)} bad=${JSON.stringify(checks.imgBad?.events ?? null)}`,
  );
  add(
    "5 injected iframe violates frame-src",
    directed(checks.frame, "frame-src"),
    JSON.stringify(checks.frame?.events ?? []),
  );
  add(
    "6 websocket violates connect-src",
    directed(checks.websocket, "connect-src"),
    JSON.stringify(checks.websocket?.events ?? []),
  );
  add(
    "7 base href violates base-uri",
    directed(checks.base, "base-uri"),
    JSON.stringify(checks.base?.events ?? []),
  );
  const formHref = checks.form?.hrefAfter ?? "";
  add(
    "8 form submit does not navigate",
    typeof probes.form === "string" &&
      typeof probes.formSubmit === "string" &&
      formHref.startsWith("about:") &&
      checks.form?.sentinel === true &&
      body.hostUrl === body.hostStart,
    `requestSubmit=${probes.form ?? "missing"} submit=${probes.formSubmit ?? "missing"} href=${formHref || "missing"} events=${JSON.stringify(checks.form?.events ?? [])}. Sandbox blocks the submit before CSP; a securitypolicyviolation is not required.`,
  );
  add("9 inline script initializes", declared?.init === true, `init=${String(declared?.init)} failed=${declared?.failed ?? ""}`);
  const nav = body.reports?.nav ?? {};
  const tornDown = new Set(["href", "assign", "replace", "windowLocation", "documentLocation", "metaRefresh"]);
  for (const name of ["href", "assign", "replace", "windowLocation", "documentLocation", "anchorClick", "metaRefresh", "formSubmit", "formRequestSubmit", "windowOpen"]) {
    const result = nav[name];
    const error = seen.find((entry) => entry.kind === `nav-${name}` && entry.method === "sf/sandbox-error");
    const killed = error?.params?.reason === "navigated";
    const href = result?.href ?? "";
    if (tornDown.has(name)) {
      const frameSrc = (result?.events ?? []).some((event) => matches(event.violated, "frame-src") || matches(event.effective, "frame-src"));
      const requested = navRequests.some((path) => path.includes(`/nav-sink/${name}`));
      const inTime = typeof error?.elapsed === "number" && error.elapsed <= 2000;
      add(
        `nav ${name}`,
        killed && inTime && body.hostUrl === body.hostStart && (frameSrc || !requested),
        `elapsed=${error?.elapsed ?? "missing"} requested=${requested} frameSrc=${frameSrc} host=${body.hostUrl ?? "missing"} events=${JSON.stringify(result?.events ?? [])}`,
      );
      continue;
    }
    add(
      `nav ${name}`,
      result?.sentinel === true && result.ping === true && href.startsWith("about:") && !killed && body.hostUrl === body.hostStart,
      `href=${href || "missing"} ping=${String(result?.ping)} thrown=${result?.thrown ?? "none"} killed=${killed} events=${JSON.stringify(result?.events ?? [])}`,
    );
  }
  const hash = declared?.hash;
  add(
    "hash click scrolls in place",
    Array.isArray(hash?.scrolled) &&
      hash.scrolled.includes("sec") &&
      hash.scrolled.includes("top") &&
      String(hash.href).startsWith("about:") &&
      hash.stay === true &&
      !seen.some((entry) => entry.kind === "declared" && entry.method === "sf/sandbox-error"),
    JSON.stringify(hash ?? null),
  );
  add(
    "host and declared shell stayed",
    body.hostUrl === body.hostStart && (body.shellSrc ?? "").includes("/shell.html"),
    `host=${body.hostUrl ?? "missing"} shell=${body.shellSrc ?? "missing"}`,
  );
  const emptyChecks = empty?.checks ?? {};
  add(
    "11 empty manifest blocks connect, img, script, and frame",
    directed(emptyChecks.connect, "connect-src") &&
      directed(emptyChecks.img, "img-src") &&
      directed(emptyChecks.script, "script-src") &&
      directed(emptyChecks.frame, "frame-src"),
    JSON.stringify({
      connect: emptyChecks.connect?.events ?? null,
      img: emptyChecks.img?.events ?? null,
      script: emptyChecks.script?.events ?? null,
      frame: emptyChecks.frame?.events ?? null,
    }),
  );
  add("isolation parent", probes.parentDocument === "SecurityError", probes.parentDocument ?? "missing");
  add("isolation top", probes.topLocation === "SecurityError", probes.topLocation ?? "missing");
  add("isolation localStorage", probes.localStorage === "SecurityError", probes.localStorage ?? "missing");
  add("isolation cookie", probes.cookie === "SecurityError", probes.cookie ?? "missing");
  add("isolation window.open", probes.open === "null", probes.open ?? "missing");
  add("isolation fetch console", probes.fetchConsole === "TypeError", probes.fetchConsole ?? "missing");
  add("isolation fetch example", probes.fetchExample === "TypeError", probes.fetchExample ?? "missing");
  const blockedHrefs = seen.filter((entry) => entry.method === "ui/notifications/link-blocked").map((entry) => entry.params?.href ?? "");
  add(
    "link blocked",
    blockedHrefs.some((href) => href.startsWith("https://example.com/out")) && blockedHrefs.every((href) => !href.startsWith("#")),
    blockedHrefs.join(",") || "missing",
  );
  add(
    "bridge initialize and binding",
    seen.some((entry) => entry.kind === "declared" && entry.method === "ui/initialize") &&
      seen.some((entry) => entry.kind === "declared" && entry.method === "tools/call") &&
      seen.some((entry) => entry.kind === "declared" && entry.method === "ui/notifications/size-changed"),
    seen.filter((entry) => entry.kind === "declared").map((entry) => entry.method).join(","),
  );
  const sizes = seen.filter((entry) => entry.kind === "declared" && entry.method === "ui/notifications/size-changed");
  const clampedSize = sizes.some(
    (entry) =>
      entry.params?.width === 8192 &&
      typeof entry.params?.height === "number" &&
      entry.params.height >= 700 &&
      entry.params.height <= 4000,
  );
  add(
    "wide document clamps size",
    clampedSize && (declared?.invalidArg?.code === "invalid_arguments" || declared?.invalidArg?.message?.includes("img-element")),
    JSON.stringify({ invalidArg: declared?.invalidArg ?? null, sizes: sizes.map((entry) => entry.params) }),
  );
  add(
    "invalid arg key rejects locally",
    declared?.invalidArg?.code === "invalid_arguments" &&
      String(declared?.invalidArg?.message ?? "").includes("img-element"),
    JSON.stringify(declared?.invalidArg ?? null),
  );
  add(
    "foreign message ignored",
    seen.some((entry) => entry.ignored && entry.method === "ui/initialize") &&
      !seen.some((entry) => entry.kind === "declared" && entry.method === "tools/call" && JSON.stringify(entry.params).includes("injected")),
    seen.filter((entry) => entry.ignored).map((entry) => `${entry.origin}:${entry.method}`).join(","),
  );
  add(
    "no sandbox-error on declared or empty",
    !seen.some((entry) => entry.method === "sf/sandbox-error" && (entry.kind === "declared" || entry.kind === "empty")),
    String(body.timedOut ?? false),
  );
  return lines;
}

const navRequests: string[] = [];

const host = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path.startsWith("/nav-sink/")) {
    navRequests.push(path);
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "POST" && path === "/report") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(204);
      res.end();
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: ReportBody = {};
      try {
        body = JSON.parse(raw) as ReportBody;
      } catch {
        body = {};
      }
      const lines = score(body, navRequests);
      for (const line of lines) {
        console.log(`${line.pass ? "PASS" : "FAIL"} ${line.name} ${line.detail}`);
      }
      const failed = lines.filter((line) => !line.pass).length;
      console.log(`${lines.length - failed} passed, ${failed} failed`);
      const dnsEvents = body.reports?.declared?.checks?.dns?.events?.length;
      console.log(
        `NOTE dns-prefetch securitypolicyviolation count=${dnsEvents ?? "missing"}. default-src 'none' is the fallback for fetch directives. A count of 0 means this browser did not report a CSP block for a dynamic <link rel=dns-prefetch>, so DNS prefetch stays an open side channel.`,
      );
      console.log(
        "NOTE form requestSubmit and form.submit: pass means the nested document stayed and the call did not leave the artifact script. The sandbox attribute blocks the submit before CSP, so a securitypolicyviolation is not required.",
      );
      void shutdown(failed === 0 ? 0 : 1);
    });
    return;
  }
  if (path === "/attacker.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(attacker);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page(sandboxOrigin, hostOrigin));
});

let sandboxOrigin = "";
let hostOrigin = "";
let sandboxClose: (() => Promise<void>) | undefined;

async function shutdown(code: number): Promise<void> {
  if (sandboxClose) await sandboxClose();
  host.close();
  setTimeout(() => process.exit(code), 50);
}

host.listen(0, "127.0.0.1", async () => {
  const address = host.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  hostOrigin = `http://127.0.0.1:${port}`;
  const sandbox = await startSandboxListener({
    consoleOrigins: [hostOrigin],
    hostPort: port,
    listenHost: "127.0.0.1",
    env: {},
  });
  sandboxClose = sandbox.close;
  sandboxOrigin = sandbox.origin ?? "";
  console.log(JSON.stringify({ hostOrigin, sandboxOrigin, url: `${hostOrigin}/` }));
  setTimeout(() => {
    console.log("FAIL browser did not report");
    void shutdown(1);
  }, 75000).unref();
});
