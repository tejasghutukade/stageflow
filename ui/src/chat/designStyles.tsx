import { useEffect, type ReactNode } from "react";
import { StaticArtifactBody } from "../redesign/artifacts/renderers/StaticPreview";

let loading: Promise<unknown> | null = null;

/** The design-system CSS that markdown and static previews use. The console loads it up front; the chat page loads it the first time one is shown. */
export function loadDesignStyles(): Promise<unknown> {
  loading ??= Promise.all([import("@astryxdesign/core/astryx.css"), import("@astryxdesign/theme-neutral/theme.css")]);
  return loading;
}

/** StaticArtifactBody for the chat page, with its styles loaded. */
export function ChatStaticBody(props: Parameters<typeof StaticArtifactBody>[0]): ReactNode {
  useEffect(() => {
    void loadDesignStyles();
  }, []);
  return <StaticArtifactBody {...props} />;
}
