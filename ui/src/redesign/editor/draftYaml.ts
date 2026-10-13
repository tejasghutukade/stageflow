import { stringify } from "yaml";
import type { DraftPackagePayload } from "../../api";
import { stagePathLabel } from "../workshop/inspector/stageFields";

export type YamlActiveFinding = {
  path: string;
  line?: number;
  message?: string;
};

export function serializeYamlDocument(value: unknown): string {
  const text = stringify(value, { indent: 2, lineWidth: 0 });
  if (!text) return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function pipelineYamlDocument(
  pipeline: DraftPackagePayload["pipeline"],
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: pipeline.id,
    stages: pipeline.stages,
  };
  if (pipeline.agent !== undefined) doc.agent = pipeline.agent;
  if (pipeline.model !== undefined) doc.model = pipeline.model;
  if (pipeline.schemas !== undefined) doc.schemas = pipeline.schemas;
  if (pipeline.requires !== undefined) doc.requires = pipeline.requires;
  return doc;
}

export function normalizeYamlPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function yamlPathsMatch(left: string, right: string): boolean {
  const a = normalizeYamlPath(left);
  const b = normalizeYamlPath(right);
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function draftFileYaml(
  draft: DraftPackagePayload,
  activePath: string | null,
  pipelinePath: string | null,
): string {
  if (!activePath) return "";
  if (
    pipelinePath &&
    normalizeYamlPath(activePath) === normalizeYamlPath(pipelinePath)
  ) {
    return serializeYamlDocument(pipelineYamlDocument(draft.pipeline));
  }
  const stage = (draft.stages ?? []).find((file) => yamlPathsMatch(file.path, activePath));
  if (!stage) return "";
  return serializeYamlDocument(stage.body);
}

export function yamlDisplayLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function knownLine(line: number | undefined): number | undefined {
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return undefined;
  return line;
}

export function yamlFooterLabel(lineCount: number, findingLine?: number): string {
  const label = `${lineCount} ${lineCount === 1 ? "line" : "lines"} · spaces 2`;
  const line = knownLine(findingLine);
  return line === undefined ? label : `${label} · Ln ${line}`;
}

export function findingLineForFile(
  finding: YamlActiveFinding | null | undefined,
  filePath: string | null,
): number | undefined {
  if (!finding || !filePath || !yamlPathsMatch(finding.path, filePath)) return undefined;
  return knownLine(finding.line);
}

export function yamlPathForSelectedStage(
  draft: DraftPackagePayload,
  stageId: string,
): string | null {
  const label = stagePathLabel(draft, stageId);
  if (!label) return null;
  const file = (draft.stages ?? []).find((entry) => yamlPathsMatch(entry.path, label));
  return file?.path ?? null;
}
