import { useEffect, useState } from "react";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Markdown } from "@astryxdesign/core/Markdown";
import { fetchRunArtifact } from "../api";
import { authorizationHeaders } from "../api/controlToken";

export type ArtifactReaderProps = {
  runId: string;
  path: string;
  readOnly?: boolean;
  onBackToTranscript?: () => void;
  onHide?: () => void;
  variant?: "legacy" | "redesign";
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

export function isImageArtifactPath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return /\.(png|jpe?g|gif|webp)$/i.test(name);
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

function artifactUrl(runId: string, path: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(path)}`;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function ArtifactReaderBody({
  load,
  mode,
  markdown,
  image,
  imageSrc,
  path,
}: {
  load: LoadState;
  mode: ViewMode;
  markdown: boolean;
  image: boolean;
  imageSrc: string | null;
  path: string;
}) {
  if (load.status === "loading") {
    return (
      <p className="text-[13px] text-[var(--sf-text-3)]">Loading…</p>
    );
  }
  if (load.status === "error") {
    return (
      <div className="rounded-lg border border-[#f2645a33] bg-[#f2645a14] px-3 py-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--sf-fail)]">
          Could not load artifact
        </p>
        <p className="mt-1 text-[13px] text-[var(--sf-text-1)]">{load.message}</p>
      </div>
    );
  }
  if (load.status !== "ready") return null;

  if (image) {
    return imageSrc ? (
      <img
        src={imageSrc}
        alt={fileName(path)}
        className="block max-w-full h-auto"
      />
    ) : null;
  }

  if (mode === "rendered" && markdown) {
    if (load.content.trim().length === 0) {
      return <p className="text-[13px] text-[var(--sf-text-3)]">Empty file.</p>;
    }
    return (
      <Markdown headingLevelStart={2} contentWidth="76ch">
        {load.content}
      </Markdown>
    );
  }

  return (
    <CodeBlock
      code={load.content}
      language={sniffLanguage(path)}
      title={fileName(path)}
      container="section"
      width="100%"
    />
  );
}

export function ArtifactReader({
  runId,
  path,
  readOnly,
  onBackToTranscript,
  onHide,
  variant = "legacy",
}: ArtifactReaderProps) {
  const markdown = isMarkdown(path);
  const image = isImageArtifactPath(path);
  const [mode, setMode] = useState<ViewMode>(
    markdown || image ? "rendered" : "raw",
  );
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  useEffect(() => {
    setMode(isMarkdown(path) || isImageArtifactPath(path) ? "rendered" : "raw");
  }, [path]);

  useEffect(() => {
    if (isImageArtifactPath(path)) {
      let cancelled = false;
      let objectUrl: string | null = null;
      setLoad({ status: "loading" });
      setImageSrc(null);
      void fetch(artifactUrl(runId, path), {
        headers: { ...authorizationHeaders() },
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(body.error ?? `Request failed (${res.status})`);
          }
          return res.blob();
        })
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          objectUrl = url;
          setImageSrc(url);
          setLoad({ status: "ready", content: "" });
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
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    setImageSrc(null);
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

  useEffect(() => {
    setCopyState("idle");
  }, [path]);

  const byteSize =
    load.status === "ready" && !image
      ? new TextEncoder().encode(load.content).length
      : null;

  if (variant === "redesign") {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col gap-2 px-4 py-3">
        <div className="flex shrink-0 items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-xs leading-[1.33] text-[var(--sf-text-1)]">
            {fileName(path)}
          </span>
          {byteSize != null ? (
            <span className="shrink-0 font-['Geist_Mono',monospace] text-[11px] text-[#8b8f98]">
              {formatByteSize(byteSize)}
            </span>
          ) : null}
          <button
            type="button"
            className="shrink-0 rounded-md border border-[#ffffff12] px-2 py-1 text-xs text-[#a7aab2] hover:text-[var(--sf-text-1)]"
            onClick={() => {
              void navigator.clipboard.writeText(path).then(() => {
                setCopyState("copied");
                window.setTimeout(() => setCopyState("idle"), 1500);
              });
            }}
          >
            {copyState === "copied" ? "Copied" : "Copy path"}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-[10px] border border-[#ffffff12] bg-[#131418] p-4">
          <ArtifactReaderBody
            load={load}
            mode={mode}
            markdown={markdown}
            image={image}
            imageSrc={imageSrc}
            path={path}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="reader" style={{ height: "100%" }}>
      <div className="reader__bar">
        <span className="reader__name">{fileName(path)}</span>
        {dirName(path) ? (
          <span className="reader__path">{dirName(path)}</span>
        ) : null}
        {readOnly ? <span className="chip">read only</span> : null}
        <span className="topbar__spacer"></span>
        <div className="stream__head-trail">
          {onBackToTranscript ? (
            <button className="btn btn--ghost btn--sm" onClick={onBackToTranscript}>
              ← Transcript
            </button>
          ) : null}
          {onHide ? (
            <button type="button" className="btn btn--sm" onClick={onHide}>
              Hide workspace
            </button>
          ) : null}
          <div className="seg">
            <button
              data-active={mode === "rendered" ? "true" : undefined}
              disabled={!markdown && !image}
              onClick={() => {
                if (markdown || image) setMode("rendered");
              }}
            >
              Rendered
            </button>
            <button
              data-active={mode === "raw" ? "true" : undefined}
              disabled={image}
              onClick={() => {
                if (!image) setMode("raw");
              }}
            >
              Raw
            </button>
            <button disabled>Diff</button>
          </div>
        </div>
      </div>

      <div className="reader__body">
        {load.status === "loading" ? (
          <p className="muted" style={{ padding: "var(--spacing-6)" }}>
            Loading…
          </p>
        ) : null}
        {load.status === "error" ? (
          <div style={{ padding: "var(--spacing-6)" }}>
            <div
              className="gate"
              style={{
                padding: "var(--spacing-4)",
                borderColor: "var(--color-border-red)",
                borderLeftColor: "var(--color-error)",
                background: "var(--color-background-red)",
                color: "var(--color-text-red)",
              }}
            >
              <div className="gate__label" style={{ color: "var(--color-text-red)" }}>
                Could not load artifact
              </div>
              <p className="gate__question" style={{ color: "var(--color-text-primary)" }}>
                {load.message}
              </p>
            </div>
          </div>
        ) : null}
        {load.status === "ready" ? (
          <div className="page">
            <ArtifactReaderBody
              load={load}
              mode={mode}
              markdown={markdown}
              image={image}
              imageSrc={imageSrc}
              path={path}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
