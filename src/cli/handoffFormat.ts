import type { StageEnvelope } from "../types/envelope.js";

export type HandoffDiagram = {
  diagram_type: string;
  summary: string;
  spec_path: string;
};

export type HandoffResult =
  | { skipped: true }
  | {
      skipped: false;
      runId: string;
      runDir: string;
      stageId: string;
      diagrams: HandoffDiagram[];
    };

function absArtifactPath(runDir: string, rel: string): string {
  const base = runDir.replace(/\/+$/, "");
  const normalized = rel.replace(/^\.\//, "");
  return `${base}/${normalized}`;
}

export function isHandoffSkipped(detectEnvelope: StageEnvelope): boolean {
  return (
    Array.isArray(detectEnvelope.fork_choice) &&
    detectEnvelope.fork_choice.length === 0
  );
}

export function buildHandoffDeliverable(input: {
  runId: string;
  runDir: string;
  stageId: string;
  envelope: StageEnvelope;
}): HandoffResult {
  const diagrams = buildDiagrams(input.runDir, input.envelope);
  if (diagrams.length === 0) {
    throw new Error(
      `no *.spec.json artifacts or payload.diagrams in envelope for stage '${input.stageId}'`,
    );
  }
  return {
    skipped: false,
    runId: input.runId,
    runDir: input.runDir,
    stageId: input.stageId,
    diagrams,
  };
}

function buildDiagrams(
  runDir: string,
  envelope: StageEnvelope,
): HandoffDiagram[] {
  const diagramsPayload = envelope.payload?.diagrams;
  if (Array.isArray(diagramsPayload) && diagramsPayload.length > 0) {
    return diagramsPayload.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new Error("invalid diagram entry in payload.diagrams");
      }
      const diagram = entry as { diagram_type?: unknown; summary?: unknown };
      const diagramType = diagram.diagram_type;
      if (typeof diagramType !== "string" || diagramType.length === 0) {
        throw new Error("payload.diagrams entry missing diagram_type");
      }
      const suffix = `${diagramType}.spec.json`;
      const rel = envelope.artifacts.find((artifact) => artifact.endsWith(suffix));
      if (!rel) {
        throw new Error(
          `no artifact matching ${diagramType}.spec.json in envelope for stage`,
        );
      }
      return {
        diagram_type: diagramType,
        summary: typeof diagram.summary === "string" ? diagram.summary : "",
        spec_path: absArtifactPath(runDir, rel),
      };
    });
  }

  return envelope.artifacts
    .filter((artifact) => /\.spec\.json$/.test(artifact))
    .map((rel) => {
      const match = rel.match(/([^/]+)\.spec\.json$/);
      const diagramType = match?.[1];
      if (!diagramType) {
        throw new Error(`invalid spec artifact path: ${rel}`);
      }
      return {
        diagram_type: diagramType,
        summary: envelope.summary ?? "",
        spec_path: absArtifactPath(runDir, rel),
      };
    });
}
