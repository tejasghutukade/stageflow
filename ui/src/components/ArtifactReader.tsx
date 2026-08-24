import { useEffect, useState } from "react";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Markdown } from "@astryxdesign/core/Markdown";
import { fetchRunArtifact } from "../api";

export type ArtifactReaderProps = {
  runId: string;
  path: string;
  readOnly?: boolean;
  onBackToTranscript: () => void;
};

type ViewMode = "rendered" | "raw" | "diff";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; content: string }
  | { status: "error"; message: string };

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirName(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function sniffLanguage(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sh")) return "bash";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".txt")) return "plaintext";
  return "plaintext";
}

export function ArtifactReader({
  runId,
  path,
  readOnly,
  onBackToTranscript,
}: ArtifactReaderProps) {
  const markdown = isMarkdown(path);
  const [mode, setMode] = useState<ViewMode>(markdown ? "rendered" : "raw");
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    setMode(isMarkdown(path) ? "rendered" : "raw");
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    void fetchRunArtifact(runId, path)
      .then((content) => {
        if (cancelled) return;
        setLoad({ status: "ready", content });
      })
      .catch((err) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [runId, path]);

  return (
    <div className="reader" style={{ height: "100%" }}>
      <div className="reader__bar">
        <span className="reader__name">{fileName(path)}</span>
        {dirName(path) ? (
          <span className="reader__path">{dirName(path)}</span>
        ) : null}
        {readOnly ? <span className="chip">read only</span> : null}
        <button className="btn btn--ghost btn--sm" onClick={onBackToTranscript}>← Transcript</button>
        <div className="seg">
          <button
            data-active={mode === "rendered" ? "true" : undefined}
            disabled={!markdown}
            onClick={() => { if (markdown) setMode("rendered"); }}
          >
            Rendered
          </button>
          <button
            data-active={mode === "raw" ? "true" : undefined}
            onClick={() => setMode("raw")}
          >
            Raw
          </button>
          <button disabled>Diff</button>
        </div>
      </div>

      <div className="reader__body">
        {load.status === "loading" ? (
          <p className="muted" style={{ padding: "var(--spacing-6)" }}>Loading…</p>
        ) : null}
        {load.status === "error" ? (
          <div style={{ padding: "var(--spacing-6)" }}>
            <div className="gate" style={{ padding: "var(--spacing-4)", borderColor: "var(--color-border-red)", borderLeftColor: "var(--color-error)", background: "var(--color-background-red)", color: "var(--color-text-red)" }}>
              <div className="gate__label" style={{ color: "var(--color-text-red)" }}>Could not load artifact</div>
              <p className="gate__question" style={{ color: "var(--color-text-primary)" }}>{load.message}</p>
            </div>
          </div>
        ) : null}
        {load.status === "ready" ? (
          <div className="page">
            {mode === "rendered" && markdown ? (
              load.content.trim().length === 0 ? (
                <p className="muted">Empty file.</p>
              ) : (
                <Markdown headingLevelStart={2} contentWidth="76ch">
                  {load.content}
                </Markdown>
              )
            ) : (
              <CodeBlock
                code={load.content}
                language={sniffLanguage(path)}
                title={fileName(path)}
                container="section"
                width="100%"
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
