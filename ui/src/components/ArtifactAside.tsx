import type { ReactNode } from "react";

export type ArtifactFile = {
  path: string;
  label?: string;
  meta?: string;
};

export type ArtifactAsideProps = {
  files: ArtifactFile[];
  selectedPath?: string;
  onSelect?: (path: string) => void;
  title?: string;
  footer?: ReactNode;
};

function fileLabel(file: ArtifactFile): string {
  return file.label ?? file.path.split("/").pop() ?? file.path;
}

export function ArtifactAside({
  files,
  selectedPath,
  onSelect,
  title = "Files",
  footer,
}: ArtifactAsideProps) {
  return (
    <aside className="aside" style={{ height: "100%" }}>
      <header className="aside__head">
        <h4 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{title}</h4>
      </header>

      <nav className="aside__body">
        {files.length === 0 ? (
          <p className="muted" style={{ padding: "var(--spacing-3) var(--spacing-4)", fontSize: "var(--font-size-sm)" }}>
            No files yet.
          </p>
        ) : (
          <div className="files">
            {files.map((file) => (
              <button
                key={file.path}
                className="files__row"
                data-selected={file.path === selectedPath ? "true" : undefined}
                onClick={onSelect ? () => onSelect(file.path) : undefined}
              >
                {fileLabel(file)}
                {file.meta ? <span>{file.meta}</span> : null}
              </button>
            ))}
          </div>
        )}
      </nav>

      {footer ? (
        <footer className="aside__foot">
          {footer}
        </footer>
      ) : null}
    </aside>
  );
}
