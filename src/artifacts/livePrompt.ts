import type { BindableFunctionInfo } from "./bindable.js";
import { LIBRARY_NAME, LIBRARY_VERSION, OPENUI_LANG_FORMAT, promptTokenEstimate, vocabularyPrompt } from "./library/index.js";
import { HTML_LIBRARIES } from "./library/htmlLibraries.js";
import { LIVE_HTML_MAX_BYTES } from "./limits.js";

export { promptTokenEstimate };

const DESCRIPTION_CAP = 200;
const IO_CAP = 600;

const MANIFEST_FIELDS = [
  "format (openui-lang)",
  `library.name (${LIBRARY_NAME})`,
  `library.version (${LIBRARY_VERSION})`,
  "bindings: id, function (the function id), args",
  "refresh: on_view, ttl_seconds, auto_seconds (optional, integers of at least 30)",
].join("; ");

const SYNTAX = "Syntax: one statement per line, name = Expression. The entry is root. $variables hold local filter state.";

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  if (max <= 3) return flat.slice(0, max);
  return `${flat.slice(0, max - 3)}...`;
}

function renderIo(input: string, output: string, cap: number): string {
  const overhead = "input . output .".length;
  const budget = Math.max(0, cap - overhead);
  const left = clip(input, budget);
  const right = clip(output, Math.max(0, budget - left.length));
  const rendered = `input ${left}. output ${right}.`;
  return rendered.length <= cap ? rendered : clip(rendered, cap);
}

export function htmlPromptSection(): string {
  const rows = HTML_LIBRARIES.map((library) => `- ${library.name}@${library.version} global ${library.globalName}: ${library.hint}`);
  return [
    "### Live HTML artifacts",
    "",
    `kind live.html. format html. One HTML document, at most ${LIVE_HTML_MAX_BYTES} bytes. libraries is an optional list of {name, version} from the Host list below (at most 6, no URLs). csp lists https origins. bindings and refresh match live.declarative.`,
    "",
    "Vendored libraries:",
    ...rows,
    "mermaid needs allowEval: true on that entry and STAGEFLOW_ARTIFACT_ALLOW_EVAL_LIBS=1. It stays off otherwise.",
    "",
    "window.stageflow.initialize runs first. callBinding(name, args) returns the binding result. onBindingUpdated(id, fn) runs when that binding refreshes. Host theme variables are the --sf-* custom properties.",
    "No iframes, links, forms, popups, or navigation. Declare every https origin in csp. Declared external origins need operator approval before they work. An external script or stylesheet needs integrity (sha256, sha384, or sha512) and crossorigin=anonymous. Text is plain text.",
    "",
    'Example: manifest libraries [{name:"chartjs", version:"' + HTML_LIBRARIES[0]!.version + '"}].',
    '<canvas id="c"></canvas><script>',
    'window.stageflow.callBinding("rows").then(function (res) {',
    "  var rows = res.rows || [];",
    '  new Chart(document.getElementById("c"), { type: "line", data: { labels: rows.map(function (r) { return r.day; }), datasets: [{ data: rows.map(function (r) { return r.n; }) }] } });',
    "});",
    "</script>",
  ].join("\n");
}

export function declarativePromptSection(): string {
  return [
    `Live program: kind live.declarative. Library ${LIBRARY_NAME} ${LIBRARY_VERSION}. format ${OPENUI_LANG_FORMAT}. A program is valid only against this library version.`,
    "",
    vocabularyPrompt(),
    "",
    SYNTAX,
    `Manifest fields: ${MANIFEST_FIELDS}. For a one-off, bindings is [] and the data is written into the program. Every string is plain text.`,
    'Example: root = Stack([card], "column", "m") then card = Card([CardHeader("Regional sales", "this quarter"), Table([Col("Region", ["North", "South"]), Col("Sales", [120, 95], "number")])]).',
  ].join("\n");
}

export function liveArtifactsPromptSection(functions: readonly BindableFunctionInfo[]): string {
  const html = htmlPromptSection();
  if (functions.length === 0) {
    return ["## Live artifacts", "", vocabularyPrompt(), "", SYNTAX, "no bindable functions: write data into the program", "", html].join("\n");
  }
  const lines = [
    "## Live artifacts",
    "",
    `Library ${LIBRARY_NAME} ${LIBRARY_VERSION}. format ${OPENUI_LANG_FORMAT}. A program is valid only against this library version.`,
    "",
    vocabularyPrompt(),
    "",
    "### Manifest",
    "",
    MANIFEST_FIELDS,
    "Query's first argument is one double-quoted string literal: the binding's function id, not the binding id. Single quotes, concatenation, operators, ternaries, escapes, and any other shape are rejected.",
    "Query argument keys should match that binding's args. A literal mismatch is a warning. $variables are allowed in args.",
    "Field reads on a Query result (including through aliases such as rows = data.rows, and inside a conditional) must exist in the function output schema when one is declared.",
    "Every string is plain text. A URL-like string is not a link or an image.",
    "",
    "### Bindable functions",
    "",
    "Query results use exactly these fields. A Query for any other tool is rejected.",
  ];
  const head = lines.join("\n");
  const render = (ioCap: number) =>
    [
      head,
      ...functions.map((fn) => `- ${fn.id}: ${clip(fn.description, DESCRIPTION_CAP)} ${renderIo(fn.input, fn.output, ioCap)}`),
    ].join("\n");
  let ioCap = IO_CAP;
  let text = render(ioCap);
  const htmlTokens = promptTokenEstimate(html);
  while (promptTokenEstimate(text) + htmlTokens >= 6000 && ioCap > 48) {
    ioCap -= 24;
    text = render(ioCap);
  }
  return `${text}\n\n${html}`;
}
