import { createContext, useContext } from "react";
import type { VisitorArtifactPayload } from "./api";

export type VisitorArtifactLoader = (key: string, version?: number) => Promise<VisitorArtifactPayload>;

const VisitorArtifactContext = createContext<VisitorArtifactLoader | null>(null);

export const VisitorArtifactProvider = VisitorArtifactContext.Provider;

export function useVisitorArtifactLoader(): VisitorArtifactLoader | null {
  return useContext(VisitorArtifactContext);
}
