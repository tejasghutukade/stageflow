import { ACCOUNT_PROFILE_TOOL_ID, ORDER_LIST_TOOL_ID, ORDER_TOOL_ID } from "./resourceContract.js";
import type { ChannelAssurance } from "./types.js";

export type SessionAssurance = ChannelAssurance | "signed_in";

export const STEP_UP_LINK_MS = 10 * 60 * 1000;
export const SIGNED_IN_ELEVATION_MS = 12 * 60 * 60 * 1000;

const RANK: Record<SessionAssurance, number> = {
  address_only: 0,
  provider_verified: 1,
  signed_in: 2,
};

const DEFAULT_REQUIRED: Record<string, SessionAssurance> = {
  [ORDER_TOOL_ID]: "provider_verified",
  [ORDER_LIST_TOOL_ID]: "provider_verified",
  [ACCOUNT_PROFILE_TOOL_ID]: "provider_verified",
};

let requiredOverrides: Record<string, SessionAssurance> = {};

export function requiredAssurance(tool: string): SessionAssurance {
  return requiredOverrides[tool] ?? DEFAULT_REQUIRED[tool] ?? "signed_in";
}

export function setRequiredAssuranceForTests(tool: string, assurance: SessionAssurance | null): void {
  if (assurance === null) delete requiredOverrides[tool];
  else requiredOverrides[tool] = assurance;
}

export function clearRequiredAssuranceOverridesForTests(): void {
  requiredOverrides = {};
}

export function assuranceMeets(current: SessionAssurance, required: SessionAssurance): boolean {
  return RANK[current] >= RANK[required];
}

export function stepUpReply(url: string): string {
  return `Sign in to continue: ${url}`;
}