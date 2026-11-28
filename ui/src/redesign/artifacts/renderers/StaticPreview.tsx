import { useState } from "react";
import { Markdown } from "@astryxdesign/core/Markdown";
import { SandboxedHtml } from "./SandboxedHtml";
import { nextTableSort, sortTableRows, type TableSort } from "./tableModel";
import type { StaticPreview } from "./previewModel";

export function MarkdownPreview({ text }: { text: string }) {
  if (text.trim().length === 0) {
    return <p className="text-[13px] text-[var(--sf-text-3)]">Empty file.</p>;
  }
  return (
    <div data-testid="artifact-markdown">
      <Markdown headingLevelStart={2} contentWidth="76ch">
        {text}
      </Markdown>
    </div>
  );
}

export function ImagePreview({ src, alt }: { src: string; alt: string }) {
  return <img src={src} alt={alt} className="block h-auto max-w-full" data-testid="artifact-image" />;
}

export function TextPreview({ text, note }: { text: string; note: string | null }) {
  return (
    <div data-testid="artifact-text" className="flex flex-col gap-2">
      {note ? <p className="text-[13px] text-[var(--sf-text-2)]">{note}</p> : null}
      <pre className="sf-mono whitespace-pre-wrap text-[13px] leading-[1.5] text-[var(--sf-text-1)]">
        {text}
      </pre>
    </div>
  );
}

export function ExplanationCard({
  testId,
  title,
  body,
}: {
  testId: string;
  title: string;
  body: string;
}) {
  return (
    <div data-testid={testId} className="max-w-[640px] rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-4 py-3">
      <h2 className="text-[15px] font-semibold text-[var(--sf-text-1)]">{title}</h2>
      <p className="mt-1 text-[13px] leading-[1.5] text-[var(--sf-text-2)]">{body}</p>
    </div>
  );
}

export function TablePreview({
  columns,
  rows,
  note,
}: {
  columns: string[];
  rows: string[][];
  note: string | null;
}) {
  const [sort, setSort] = useState<TableSort>(null);
  const visible = sort ? sortTableRows(rows, sort.column, sort.direction) : rows;
  return (
    <div data-testid="artifact-table" className="flex flex-col gap-2">
      <div className="overflow-auto">
        <table className="w-full border-collapse text-left text-[13px] text-[var(--sf-text-1)]">
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  key={`${column}-${index}`}
                  aria-sort={
                    sort?.column === index
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  className="border-b border-[var(--sf-hairline)] px-2 py-1.5 font-medium"
                >
                  <button
                    type="button"
                    className="text-left text-[var(--sf-text-2)]"
                    onClick={() => {
                      setSort((current) => nextTableSort(current, index));
                    }}
                  >
                    {column}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {columns.map((_, index) => (
                  <td key={index} className="border-b border-[var(--sf-hairline)] px-2 py-1.5 align-top">
                    {row[index] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note ? <p className="text-[13px] text-[var(--sf-text-2)]">{note}</p> : null}
    </div>
  );
}

export function StaticArtifactBody({
  preview,
  imageUrl,
  imageAlt,
}: {
  preview: StaticPreview;
  imageUrl?: string | null;
  imageAlt: string;
}) {
  switch (preview.mode) {
    case "markdown":
      return <MarkdownPreview text={preview.text} />;
    case "image":
      return imageUrl ? <ImagePreview src={imageUrl} alt={imageAlt} /> : (
        <p className="text-[13px] text-[var(--sf-text-3)]">Loading image…</p>
      );
    case "table":
      return <TablePreview columns={preview.columns} rows={preview.rows} note={preview.note} />;
    case "text":
      return <TextPreview text={preview.text} note={preview.note} />;
    case "html":
      return <SandboxedHtml text={preview.text} source={<TextPreview text={preview.text} note={null} />} />;
    case "unavailable":
      return <ExplanationCard testId="artifact-unavailable" title={preview.title} body={preview.body} />;
    case "too-large":
      return <ExplanationCard testId="artifact-too-large" title={preview.title} body={preview.body} />;
    case "cannot-preview":
      return <ExplanationCard testId="artifact-cannot-preview" title={preview.title} body={preview.body} />;
  }
}
