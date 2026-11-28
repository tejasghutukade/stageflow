import { useState } from "react";
import { HTML_LIBRARY_FLAGS } from "../../../../src/artifacts/library/htmlLibraryFlags.ts";
import { libraryCspSources, liveHtmlDocumentCsp } from "../../redesign/artifacts/liveHtml/cspPolicy";
import { useSandboxOrigin } from "../../redesign/artifacts/sandbox/sandboxOrigin";
import { useSandboxBridge } from "../../redesign/artifacts/sandbox/useSandboxBridge";

/** Changes whenever the card's content does, so a new program or library set mounts a fresh frame and bridge. */
function cardKey(origin: string, program: string, libraries: readonly { name: string; version: string }[]): string {
  let hash = 0;
  for (let index = 0; index < program.length; index += 1) hash = (hash * 31 + program.charCodeAt(index)) | 0;
  const libs = libraries.map((library) => `${library.name}@${library.version}`).join(",");
  return `${origin}|${(hash >>> 0).toString(36)}:${program.length}|${libs}`;
}

export function HtmlCardSandbox({ program, libraries }: { program: string; libraries: readonly { name: string; version: string }[] }) {
  const { origin, ready } = useSandboxOrigin();
  if (!ready) return <p className="text-[13px] text-[var(--sf-text-3)]">Loading card…</p>;
  if (!origin) {
    return (
      <p className="text-[13px] text-[var(--sf-text-2)]" data-testid="html-card-no-sandbox">
        This card needs the Host&apos;s sandbox to display.
      </p>
    );
  }
  return <HtmlCardFrame key={cardKey(origin, program, libraries)} program={program} libraries={libraries} origin={origin} />;
}

/** One mount per card content: the shared sandbox frame core builds the bridge once, as on the artifact page. */
function HtmlCardFrame({
  program,
  libraries,
  origin,
}: {
  program: string;
  libraries: readonly { name: string; version: string }[];
  origin: string;
}) {
  const [timedOut, setTimedOut] = useState(false);
  const [setup] = useState(() => {
    const selected = libraries.flatMap((ref) => {
      const library = HTML_LIBRARY_FLAGS.find((item) => item.name === ref.name && item.version === ref.version);
      return library ? [library] : [];
    });
    const needsEval = selected.some((library) => library.needsEval);
    const csp = liveHtmlDocumentCsp({}, { ...libraryCspSources(origin, libraries), shellOrigin: origin, needsEval });
    return { csp, needsEval, libraryRefs: libraries.map((library) => ({ name: library.name, version: library.version })) };
  });
  const frame = useSandboxBridge({
    origin,
    html: program,
    csp: setup.csp,
    libraries: setup.libraryRefs,
    allowEval: setup.needsEval,
    initialHeight: 200,
    onTimeout: () => setTimedOut(true),
  });
  const stopped = timedOut || frame.stopped !== null;
  const height = frame.height ?? 200;
  return (
    <div ref={frame.containerRef} data-testid="html-card-frame" data-csp={setup.csp}>
      {stopped ? (
        <p role="alert" className="m-0 mb-2 text-[13px] text-[var(--sf-text-2)]" data-testid="html-card-stopped">
          This card could not be shown.
        </p>
      ) : null}
      <iframe
        ref={frame.iframeRef}
        title="HTML card"
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        loading="eager"
        src={frame.src}
        data-testid="html-card-shell"
        style={{ height, minHeight: height }}
        className={`block w-full border-0 rounded-md ${frame.phase === "live" && !stopped ? "" : "invisible"}`}
      />
    </div>
  );
}
