import { createLibrary, generatePrompt, type LibraryJSONSchema, type PromptOptions } from "./langCore.js";
import { libraryComponents } from "./components.js";

export const LIBRARY_NAME = "stageflow";
export const LIBRARY_VERSION = "1.0.0";
export const OPENUI_LANG_FORMAT = "openui-lang";

/** Components that must not appear in the vocabulary. */
export const EXCLUDED_COMPONENT_NAMES = [
  "Image",
  "Carousel",
  "ImageGallery",
  "Link",
  "Embed",
  "Markdown",
  "Form",
  "FormControl",
  "Buttons",
] as const;

export const EXCLUDED_FEATURES = ["Mutation", "@ToAssistant", "@OpenUrl", "@Run(Mutation)"] as const;

export type VocabularyEntry = {
  name: string;
  description: string;
  props: readonly string[];
};

function propNames(props: { shape: Record<string, unknown> }): string[] {
  return Object.keys(props.shape);
}

export const VOCABULARY: readonly VocabularyEntry[] = libraryComponents.map((component) => ({
  name: component.name,
  description: component.description,
  props: propNames(component.props),
}));

export const VOCABULARY_NAMES: readonly string[] = VOCABULARY.map((entry) => entry.name);

export const stageflowLibrary = createLibrary({
  id: LIBRARY_NAME,
  root: "Stack",
  components: [...libraryComponents],
});

let schemaCache: LibraryJSONSchema | undefined;

export function libraryJsonSchema(): LibraryJSONSchema {
  schemaCache ??= stageflowLibrary.toJSONSchema();
  return schemaCache;
}

const ACTION_REPLACEMENT = `## Action — Button Behavior

Button actions are local only: one @Set, @Reset, or @Run of a Query, or Action([those steps]).
@Set($name, value) writes a $variable. @Reset($name) restores its default. @Run(queryName) refetches that Query.
@ToAssistant, @OpenUrl, Mutation, and @Run of a Mutation are rejected.`;

function replaceSection(text: string, heading: string, replacement: string): string {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return text;
  const next = text.indexOf("\n## ", start + 3);
  const end = next < 0 ? text.length : next + 1;
  return `${text.slice(0, start)}${replacement.trim()}\n${text.slice(end)}`;
}

function dropLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/ToAssistant|OpenUrl|FormControl|\bMutation\b|\bForm\(/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

let promptCache: string | undefined;

/** Vocabulary prompt from lang-core, with Mutation and external actions removed. */
export function vocabularyPrompt(): string {
  if (promptCache) return promptCache;
  const generated = stageflowLibrary.prompt({
    preamble: `OpenUI Lang subset for the Stageflow library ${LIBRARY_NAME} ${LIBRARY_VERSION}. Use only the components below.`,
    toolCalls: false,
    bindings: true,
    builtinFunctions: false,
    additionalRules: [
      "A statement is `name = Expression` on its own line. Forward references are allowed.",
      "The entry is `root`. $variables hold local filter state.",
      'Query(tool, args, default, refreshSeconds) reads a bound function. tool is exactly one double-quoted string literal, the function id, with no concatenation, operators, ternary, single quotes, or backslash escapes. args may use $variables. refreshSeconds is optional.',
      "Do not call Mutation. Do not use @ToAssistant or @OpenUrl. @Run may name a Query only.",
      "No component loads a URL. Text props are plain text.",
    ],
  } satisfies PromptOptions);
  promptCache = dropLines(replaceSection(generated, "Action — Button Behavior", ACTION_REPLACEMENT));
  return promptCache;
}

export function promptTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export type LibraryVersionStatus = "current" | "older" | "newer" | "unknown";

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function libraryVersionStatus(manifest: {
  library?: { name?: unknown; version?: unknown };
}): LibraryVersionStatus {
  const name = manifest.library?.name;
  const version = manifest.library?.version;
  if (name !== LIBRARY_NAME || typeof version !== "string") return "unknown";
  const parsed = parseVersion(version);
  const current = parseVersion(LIBRARY_VERSION);
  if (!parsed || !current) return "unknown";
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index]! < current[index]!) return "older";
    if (parsed[index]! > current[index]!) return "newer";
  }
  return "current";
}

export { generatePrompt };
