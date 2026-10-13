import {
  createLiveWorkshopOperatorHost,
  type LiveWorkshopOperatorHostOptions,
} from "./piModel.js";
import type { OperatorAgentHost } from "./types.js";

export const AGENT_PORT_BACKENDS = ["pi"] as const;

export type AgentPortBackendId = (typeof AGENT_PORT_BACKENDS)[number];

/** Stays up, takes a message, and answers. Stage runs stay on StagePort. */
export type AgentPort = OperatorAgentHost;

export type AgentPortOptions = LiveWorkshopOperatorHostOptions & {
  backend?: AgentPortBackendId;
};

export function createPiAgentPort(
  options: LiveWorkshopOperatorHostOptions,
): AgentPort {
  return createLiveWorkshopOperatorHost(options);
}

export function resolveAgentPort(options: AgentPortOptions): AgentPort {
  const backend = options.backend ?? "pi";
  switch (backend) {
    case "pi":
      return createPiAgentPort(options);
  }
}
