export type ArtifactOwner =
  | { kind: "stage"; pipeline: string; stage: string }
  | { kind: "agent"; agent: string }
  | { kind: "guide" };

export type ArtifactOwnerKind = ArtifactOwner["kind"];
export type ParsedOwner = ArtifactOwner;

/** The owner fields an owner kind stores; each maps to one `owner_*` column of `artifacts`. */
export type OwnerField = "pipeline" | "stage" | "agent";

export type OwnerColumns = {
  owner_kind: string;
  owner_pipeline: string | null;
  owner_stage: string | null;
  owner_agent: string | null;
};

const FIELD_COLUMN: Record<OwnerField, "owner_pipeline" | "owner_stage" | "owner_agent"> = {
  pipeline: "owner_pipeline",
  stage: "owner_stage",
  agent: "owner_agent",
};

type OwnerOf<K extends ArtifactOwnerKind> = Extract<ArtifactOwner, { kind: K }>;

export type ArtifactOwnerDescriptor<K extends ArtifactOwnerKind = ArtifactOwnerKind> = {
  kind: K;
  /** Display name in messages ("Guide artifacts do not attach functions"). */
  title: string;
  /** The stored owner fields, in key order. */
  fields: readonly OwnerField[];
  /** Prefix of every key of this kind (`stage:`), or undefined when the key is one fixed word. */
  keyPrefix?: string;
  toKey: (owner: OwnerOf<K>) => string;
  /** The key as SQL over the row's columns (`alias.owner_*`). */
  keySql: (alias: string) => string;
  parseKey: (ownerKey: string) => OwnerOf<K> | undefined;
  /** CLI owner column text. */
  label: (owner: OwnerOf<K>) => string;
  /** Bare (unprefixed) owner filter values that match this owner in the CLI. */
  filterNames: (owner: OwnerOf<K>) => string[];
  /** Word an owner substring filter also matches (the Guide has no owner columns). */
  filterWord?: string;
  /** Whether a live artifact of this owner may bind functions. */
  canBind: boolean;
  /** Whether content can fall back to a file in a run workspace when the store has none. */
  workspaceContent: boolean;
};

function ownerFieldValue(owner: ArtifactOwner, field: OwnerField): string {
  return (owner as Partial<Record<OwnerField, string>>)[field] ?? "";
}

const stage: ArtifactOwnerDescriptor<"stage"> = {
  kind: "stage",
  title: "Stage",
  fields: ["pipeline", "stage"],
  keyPrefix: "stage:",
  toKey: (owner) => `stage:${owner.pipeline}:${owner.stage}`,
  keySql: (a) => `'stage:' || COALESCE(${a}.owner_pipeline, '') || ':' || COALESCE(${a}.owner_stage, '')`,
  parseKey: (ownerKey) => {
    if (!ownerKey.startsWith("stage:")) return undefined;
    const rest = ownerKey.slice("stage:".length);
    const colon = rest.indexOf(":");
    if (colon <= 0 || colon === rest.length - 1) return undefined;
    const pipeline = rest.slice(0, colon);
    const stageId = rest.slice(colon + 1);
    if (pipeline.includes("::") || stageId.includes("::")) return undefined;
    return { kind: "stage", pipeline, stage: stageId };
  },
  label: (owner) => `${owner.pipeline}:${owner.stage}`,
  filterNames: (owner) => [`${owner.pipeline}:${owner.stage}`],
  canBind: true,
  workspaceContent: true,
};

const agent: ArtifactOwnerDescriptor<"agent"> = {
  kind: "agent",
  title: "Agent",
  fields: ["agent"],
  keyPrefix: "agent:",
  toKey: (owner) => `agent:${owner.agent}`,
  keySql: (a) => `'agent:' || COALESCE(${a}.owner_agent, '')`,
  parseKey: (ownerKey) => {
    if (!ownerKey.startsWith("agent:")) return undefined;
    const agentId = ownerKey.slice("agent:".length);
    if (agentId.length === 0 || agentId.includes("::") || agentId.includes("/")) return undefined;
    return { kind: "agent", agent: agentId };
  },
  label: (owner) => `agent:${owner.agent}`,
  filterNames: (owner) => [owner.agent, `agent:${owner.agent}`],
  canBind: true,
  workspaceContent: true,
};

export const GUIDE_OWNER_KEY = "guide";

const guide: ArtifactOwnerDescriptor<"guide"> = {
  kind: "guide",
  title: "Guide",
  fields: [],
  toKey: () => GUIDE_OWNER_KEY,
  keySql: () => `'${GUIDE_OWNER_KEY}'`,
  parseKey: (ownerKey) => (ownerKey === GUIDE_OWNER_KEY ? { kind: "guide" } : undefined),
  label: () => GUIDE_OWNER_KEY,
  filterNames: () => [GUIDE_OWNER_KEY],
  filterWord: GUIDE_OWNER_KEY,
  canBind: false,
  workspaceContent: false,
};

export const ARTIFACT_OWNERS: { readonly [K in ArtifactOwnerKind]: ArtifactOwnerDescriptor<K> } = { stage, agent, guide };

/** Rows with an unknown `owner_kind` read as stage rows, as they always have. */
const FALLBACK_OWNER: ArtifactOwnerKind = "stage";

const DESCRIPTORS = Object.values(ARTIFACT_OWNERS) as ArtifactOwnerDescriptor[];

export function ownerDescriptor<K extends ArtifactOwnerKind>(kind: K): ArtifactOwnerDescriptor<K> {
  return ARTIFACT_OWNERS[kind] as ArtifactOwnerDescriptor<K>;
}

function descriptorOf(owner: ArtifactOwner): ArtifactOwnerDescriptor {
  return ARTIFACT_OWNERS[owner.kind] as ArtifactOwnerDescriptor;
}

function rowDescriptor(ownerKind: string): ArtifactOwnerDescriptor {
  const known = (ARTIFACT_OWNERS as Record<string, ArtifactOwnerDescriptor | undefined>)[ownerKind];
  return known ?? (ARTIFACT_OWNERS[FALLBACK_OWNER] as ArtifactOwnerDescriptor);
}

export function artifactOwnerKey(owner: ArtifactOwner): string {
  return descriptorOf(owner).toKey(owner);
}

export function parseOwnerKey(ownerKey: string): ParsedOwner | undefined {
  if (ownerKey.includes("::")) return undefined;
  for (const descriptor of DESCRIPTORS) {
    const owner = descriptor.parseKey(ownerKey);
    if (owner) return owner;
  }
  return undefined;
}

/** Whether a filter value names an owner key of some kind (`stage:…`, `agent:…`). */
export function hasOwnerKeyPrefix(value: string): boolean {
  return DESCRIPTORS.some((descriptor) => descriptor.keyPrefix !== undefined && value.startsWith(descriptor.keyPrefix));
}

export function ownerLabel(owner: ArtifactOwner): string {
  return descriptorOf(owner).label(owner);
}

export function ownerFilterNames(owner: ArtifactOwner): string[] {
  return descriptorOf(owner).filterNames(owner);
}

export function ownerTitle(owner: ArtifactOwner): string {
  return descriptorOf(owner).title;
}

export function ownerCanBind(owner: ArtifactOwner): boolean {
  return descriptorOf(owner).canBind;
}

export function ownerWorkspaceContent(owner: ArtifactOwner): boolean {
  return descriptorOf(owner).workspaceContent;
}

/** The owner's id pieces, for callers that validate each one. */
export function ownerFields(owner: ArtifactOwner): Array<{ field: OwnerField; value: string }> {
  return descriptorOf(owner).fields.map((field) => ({ field, value: ownerFieldValue(owner, field) }));
}

export function ownerColumns(owner: ArtifactOwner): OwnerColumns {
  const columns: OwnerColumns = { owner_kind: owner.kind, owner_pipeline: null, owner_stage: null, owner_agent: null };
  for (const field of descriptorOf(owner).fields) columns[FIELD_COLUMN[field]] = ownerFieldValue(owner, field);
  return columns;
}

export function ownerFromRow(row: OwnerColumns): ArtifactOwner {
  const descriptor = rowDescriptor(row.owner_kind);
  const owner: Record<string, string> = { kind: descriptor.kind };
  for (const field of descriptor.fields) owner[field] = row[FIELD_COLUMN[field]] ?? "";
  return owner as ArtifactOwner;
}

export function ownerKeyFromRow(row: OwnerColumns): string {
  return artifactOwnerKey(ownerFromRow(row));
}

/** Search text for the owner: its key followed by each field (`stage:p:s p s`). */
export function ownerSearchText(row: OwnerColumns): string {
  const owner = ownerFromRow(row);
  const descriptor = descriptorOf(owner);
  return [descriptor.toKey(owner), ...descriptor.fields.map((field) => ownerFieldValue(owner, field))].join(" ").trim();
}

/** `ownerSearchText` as SQL over `alias`. */
export function ownerSearchTextSql(alias: string): string {
  const fallback = ARTIFACT_OWNERS[FALLBACK_OWNER] as ArtifactOwnerDescriptor;
  const text = (descriptor: ArtifactOwnerDescriptor) =>
    [descriptor.keySql(alias), ...descriptor.fields.map((field) => `COALESCE(${alias}.${FIELD_COLUMN[field]}, '')`)].join(" || ' ' || ");
  const whens = DESCRIPTORS.filter((descriptor) => descriptor !== fallback)
    .map((descriptor) => `WHEN '${descriptor.kind}' THEN ${text(descriptor)}`)
    .join(" ");
  return `CASE ${alias}.owner_kind ${whens} ELSE ${text(fallback)} END`;
}

/** SQL for an owner substring filter: every owner column plus each kind's filter word, lowercased. */
export function ownerSubstringSql(alias: string, param: string): string {
  const columns = [...new Set(DESCRIPTORS.flatMap((descriptor) => descriptor.fields.map((field) => FIELD_COLUMN[field])))];
  const parts = columns.map((column) => `coalesce(${alias}.${column}, '')`);
  const words = DESCRIPTORS.filter((descriptor) => descriptor.filterWord !== undefined).map(
    (descriptor) => `CASE WHEN ${alias}.owner_kind = '${descriptor.kind}' THEN ' ${descriptor.filterWord}' ELSE '' END`,
  );
  return `instr(lower(trim(${[parts.join(" || ' ' || "), ...words].join(" || ")})), @${param}) > 0`;
}

/** SQL matching one owner's rows. Parameters are named `${paramPrefix}${field}`. */
export function ownerMatchSql(
  owner: ArtifactOwner,
  options: { alias?: string; paramPrefix?: string } = {},
): { sql: string; params: Record<string, string> } {
  const column = (name: string) => (options.alias ? `${options.alias}.${name}` : name);
  const prefix = options.paramPrefix ?? "";
  const params: Record<string, string> = {};
  const parts = [`${column("owner_kind")} = '${owner.kind}'`];
  for (const { field, value } of ownerFields(owner)) {
    parts.push(`${column(FIELD_COLUMN[field])} = @${prefix}${field}`);
    params[`${prefix}${field}`] = value;
  }
  return { sql: parts.join(" AND "), params };
}
