import type { BindableFunctionInfo } from "./bindable.js";
import { LIBRARY_NAME, LIBRARY_VERSION, OPENUI_LANG_FORMAT, promptTokenEstimate, vocabularyPrompt } from "./library/index.js";

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

export function liveArtifactsPromptSection(functions: readonly BindableFunctionInfo[]): string {
  if (functions.length === 0) {
    return ["## Live artifacts", "", vocabularyPrompt(), "", SYNTAX, "no bindable functions: write data into the program"].join("\n");
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
  while (promptTokenEstimate(text) >= 4500 && ioCap > 48) {
    ioCap -= 24;
    text = render(ioCap);
  }
  return text;
}
