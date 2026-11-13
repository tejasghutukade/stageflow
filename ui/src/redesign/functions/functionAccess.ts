import type { FunctionApiCapability, FunctionBinding, FunctionCapability, FunctionFileCapability, FunctionKind } from "../../api/functions";

export type ArtifactAccess = "none" | "read" | "write";
export type ApiEffect = "read" | "action";

export type EnvAccess = { alias: string; required: boolean; capabilityId: string };

export type NetworkAccess = {
  capabilityId: string;
  origin: string;
  effect: ApiEffect;
  credentialRef?: string;
};

export type FunctionAccess = {
  artifacts: ArtifactAccess;
  env: EnvAccess[];
  network: NetworkAccess[];
  advanced: FunctionCapability[];
};

const READ_METHODS = ["GET"];
const ACTION_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const ARTIFACT_LABEL: Record<ArtifactAccess, string> = {
  none: "None",
  read: "Read",
  write: "Read and write",
};

export function writeOffered(kind: FunctionKind, artifacts: ArtifactAccess): boolean {
  return kind === "tool" || artifacts === "write";
}

export function actionOffered(kind: FunctionKind, effect: ApiEffect): boolean {
  return kind === "tool" || effect === "action";
}

export function artifactChoices(kind: FunctionKind, artifacts: ArtifactAccess): string[] {
  const choices = [ARTIFACT_LABEL.none, ARTIFACT_LABEL.read];
  if (writeOffered(kind, artifacts)) choices.push(ARTIFACT_LABEL.write);
  return choices;
}

export function effectChoices(kind: FunctionKind, effect: ApiEffect): Array<{ value: ApiEffect; label: string }> {
  const choices: Array<{ value: ApiEffect; label: string }> = [{ value: "read", label: "Read" }];
  if (actionOffered(kind, effect)) choices.push({ value: "action", label: "Action" });
  return choices;
}

export function artifactFromLabel(label: string): ArtifactAccess {
  if (label === ARTIFACT_LABEL.write) return "write";
  if (label === ARTIFACT_LABEL.read) return "read";
  return "none";
}

export function artifactLabel(artifacts: ArtifactAccess): string {
  return ARTIFACT_LABEL[artifacts];
}

export function nextCapabilityId(prefix: string, capabilities: readonly { id: string }[]): string {
  const taken = new Set(capabilities.map((capability) => capability.id));
  let n = capabilities.length + 1;
  while (taken.has(`${prefix}_${n}`)) n += 1;
  return `${prefix}_${n}`;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isSimpleApi(capability: FunctionCapability): capability is FunctionApiCapability {
  if (capability.type !== "api" || capability.path_prefix !== "/") return false;
  if (capability.effect === "read") return sameList(capability.methods, READ_METHODS);
  return capability.effect === "action" && sameList(capability.methods, ACTION_METHODS);
}

function simpleArtifacts(capabilities: readonly FunctionCapability[]): FunctionFileCapability | null {
  const matches = capabilities.filter(
    (capability): capability is FunctionFileCapability => capability.type === "file" && capability.root === "artifacts" && capability.path === "",
  );
  return matches.length === 1 ? matches[0]! : null;
}

export function accessFromDefinition(
  capabilities: readonly FunctionCapability[],
  bindings: readonly FunctionBinding[],
  kind: FunctionKind,
): FunctionAccess {
  void kind;
  const artifactsCap = simpleArtifacts(capabilities);
  const env: EnvAccess[] = [];
  const network: NetworkAccess[] = [];
  const advanced: FunctionCapability[] = [];
  for (const capability of capabilities) {
    if (artifactsCap && capability.id === artifactsCap.id) continue;
    if (capability.type === "env") {
      const binding = bindings.find((item) => item.alias === capability.alias);
      env.push({ alias: capability.alias, required: binding ? binding.required : true, capabilityId: capability.id });
      continue;
    }
    if (isSimpleApi(capability)) {
      network.push({
        capabilityId: capability.id,
        origin: capability.origin,
        effect: capability.effect,
        ...(capability.credential_ref ? { credentialRef: capability.credential_ref } : {}),
      });
      continue;
    }
    advanced.push(capability);
  }
  return {
    artifacts: artifactsCap ? artifactsCap.access : "none",
    env,
    network,
    advanced,
  };
}

function allocateId(prefix: string, preferred: string | undefined, taken: Set<string>): string {
  if (preferred && !taken.has(preferred)) {
    taken.add(preferred);
    return preferred;
  }
  if (prefix === "artifacts" && !taken.has("artifacts")) {
    taken.add("artifacts");
    return "artifacts";
  }
  let n = taken.size + 1;
  while (taken.has(`${prefix}_${n}`)) n += 1;
  const id = `${prefix}_${n}`;
  taken.add(id);
  return id;
}

function fileCapability(id: string, access: "read" | "write"): FunctionFileCapability {
  return { id, type: "file", root: "artifacts", path: "", access };
}

function apiCapability(id: string, row: NetworkAccess, effect: ApiEffect): FunctionApiCapability {
  const credential = row.credentialRef?.trim();
  return {
    id,
    type: "api",
    origin: row.origin,
    methods: effect === "action" ? [...ACTION_METHODS] : [...READ_METHODS],
    path_prefix: "/",
    effect,
    ...(credential ? { credential_ref: credential } : {}),
  };
}

function resolveArtifacts(kind: FunctionKind, current: ArtifactAccess, requested: ArtifactAccess): "read" | "write" | "none" {
  if (requested === "write" && !writeOffered(kind, current)) return "read";
  return requested;
}

function resolveEffect(kind: FunctionKind, current: ApiEffect | undefined, requested: ApiEffect): ApiEffect {
  if (requested === "action" && !actionOffered(kind, current ?? "read")) return "read";
  return requested;
}

export function applyAccess(
  current: { capabilities: readonly FunctionCapability[]; bindings: readonly FunctionBinding[] },
  next: FunctionAccess,
  kind: FunctionKind,
): { capabilities: FunctionCapability[]; bindings: FunctionBinding[] } {
  const currentAccess = accessFromDefinition(current.capabilities, current.bindings, kind);
  const artifacts = resolveArtifacts(kind, currentAccess.artifacts, next.artifacts);
  const envById = new Map(next.env.filter((row) => row.capabilityId).map((row) => [row.capabilityId, row]));
  const apiById = new Map(next.network.filter((row) => row.capabilityId).map((row) => [row.capabilityId, row]));
  const advancedById = new Map(next.advanced.map((capability) => [capability.id, capability]));
  const artifactsCap = simpleArtifacts(current.capabilities);
  const taken = new Set(next.advanced.map((capability) => capability.id));
  const capabilities: FunctionCapability[] = [];
  const rowForId = new Map<string, EnvAccess>();
  const emittedEnv = new Set<string>();
  const emittedApi = new Set<string>();
  let emittedArtifacts = false;

  const pushEnv = (id: string, row: EnvAccess) => {
    taken.add(id);
    rowForId.set(id, row);
    capabilities.push({ id, type: "env", alias: row.alias });
  };

  for (const capability of current.capabilities) {
    if (artifactsCap && capability.id === artifactsCap.id && capability.type === "file") {
      if (artifacts === "none") continue;
      emittedArtifacts = true;
      taken.add(capability.id);
      capabilities.push(fileCapability(capability.id, artifacts));
      continue;
    }
    if (capability.type === "env" && envById.has(capability.id)) {
      const row = envById.get(capability.id)!;
      emittedEnv.add(capability.id);
      pushEnv(capability.id, row);
      continue;
    }
    if (capability.type === "api" && isSimpleApi(capability) && apiById.has(capability.id)) {
      const row = apiById.get(capability.id)!;
      const effect = resolveEffect(kind, capability.effect, row.effect);
      emittedApi.add(capability.id);
      taken.add(capability.id);
      capabilities.push(apiCapability(capability.id, row, effect));
      continue;
    }
    const advanced = advancedById.get(capability.id);
    if (advanced) {
      taken.add(advanced.id);
      capabilities.push(advanced);
    }
  }

  if (!emittedArtifacts && artifacts !== "none") {
    capabilities.push(fileCapability(allocateId("artifacts", undefined, taken), artifacts));
  }
  for (const row of next.env) {
    if (row.capabilityId && emittedEnv.has(row.capabilityId)) continue;
    const id = allocateId("env", row.capabilityId || undefined, taken);
    pushEnv(id, row);
  }
  for (const row of next.network) {
    if (row.capabilityId && emittedApi.has(row.capabilityId)) continue;
    const currentEffect = current.capabilities.find((capability) => capability.id === row.capabilityId && capability.type === "api");
    const effect = resolveEffect(kind, currentEffect && currentEffect.type === "api" ? currentEffect.effect : undefined, row.effect);
    const id = allocateId("api", row.capabilityId || undefined, taken);
    capabilities.push(apiCapability(id, row, effect));
  }
  for (const capability of next.advanced) {
    if (capabilities.some((item) => item.id === capability.id)) continue;
    capabilities.push(capability);
  }

  const bindings = capabilities.flatMap((capability) => {
    if (capability.type !== "env") return [];
    const row = rowForId.get(capability.id);
    if (row) return [{ alias: capability.alias, required: row.required }];
    const previous = current.bindings.find((binding) => binding.alias === capability.alias);
    return [previous ?? { alias: capability.alias, required: true }];
  });
  return { capabilities, bindings };
}

function fileLabel(capability: FunctionFileCapability): string {
  const verb = capability.access === "write" ? "Write" : "Read";
  const root = capability.root === "workspace" ? "workspace" : "artifacts";
  const path = capability.path && capability.path !== "." ? ` ${capability.path}` : "";
  return `${verb} ${root}${path}`;
}

export function describeAccess(capabilities: readonly FunctionCapability[]): string[] {
  return capabilities.map((capability) => {
    if (capability.type === "file") return fileLabel(capability);
    if (capability.type === "env") return `Env ${capability.alias}`;
    return `API ${capability.origin} (${capability.effect})`;
  });
}

export function formatAccessSummary(capabilities: readonly FunctionCapability[]): string {
  const labels = describeAccess(capabilities);
  if (labels.length === 0) return "No access. This function can only work on its context.";
  return labels.join(" · ");
}
