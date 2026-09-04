import {
  EnvelopeError,
  type StageEnvelope,
} from "../types/envelope.js";
import type { CloneForkItem } from "../types/forkChoice.js";

type ParsedCloneForkItem = {
  successor_id: string;
  action: "skip" | "once" | "fanout";
  envelope?: StageEnvelope;
  mode?: "parallel" | "sequential";
  clones?: Array<{ envelope: StageEnvelope }>;
};

function parseCloneForkItem(raw: unknown, index: number): ParsedCloneForkItem {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EnvelopeError(`clone_forks[${index}] must be an object`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.successor_id !== "string") {
    throw new EnvelopeError(`clone_forks[${index}].successor_id must be a string`);
  }

  const action = record.action;
  if (action !== "skip" && action !== "once" && action !== "fanout") {
    throw new EnvelopeError(
      `clone_forks[${index}].action must be "skip", "once", or "fanout"`,
    );
  }

  const item: ParsedCloneForkItem = {
    successor_id: record.successor_id,
    action,
  };

  if (record.envelope !== undefined) {
    item.envelope = assertRequiredEnvelope(record.envelope);
  }

  if (record.mode !== undefined) {
    if (record.mode !== "parallel" && record.mode !== "sequential") {
      throw new EnvelopeError(
        `clone_forks[${index}].mode must be "parallel" or "sequential"`,
      );
    }
    item.mode = record.mode;
  }

  if (record.clones !== undefined) {
    if (!Array.isArray(record.clones)) {
      throw new EnvelopeError(`clone_forks[${index}].clones must be an array`);
    }
    item.clones = record.clones.map((clone, cloneIndex) => {
      if (clone === null || typeof clone !== "object" || Array.isArray(clone)) {
        throw new EnvelopeError(
          `clone_forks[${index}].clones[${cloneIndex}] must be an object`,
        );
      }
      const cloneRecord = clone as Record<string, unknown>;
      if (cloneRecord.envelope === undefined) {
        throw new EnvelopeError(
          `clone_forks[${index}].clones[${cloneIndex}].envelope is required`,
        );
      }
      return { envelope: assertRequiredEnvelope(cloneRecord.envelope) };
    });
  }

  return item;
}

export function parseCloneForks(raw: unknown): CloneForkItem[] {
  if (!Array.isArray(raw)) {
    throw new EnvelopeError("clone_forks must be an array");
  }
  return raw.map((item, index) => parseCloneForkItem(item, index) as CloneForkItem);
}

export function assertRequiredEnvelope(value: unknown): StageEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EnvelopeError("envelope must be an object");
  }

  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "success" && status !== "failure") {
    throw new EnvelopeError('status must be "success" or "failure"');
  }

  if (typeof record.summary !== "string" || record.summary.trim() === "") {
    throw new EnvelopeError("summary must be a non-empty string");
  }

  if (!("artifacts" in record)) {
    throw new EnvelopeError("artifacts field is required");
  }
  if (!Array.isArray(record.artifacts)) {
    throw new EnvelopeError("artifacts must be an array");
  }
  if (!record.artifacts.every((item) => typeof item === "string")) {
    throw new EnvelopeError("artifacts must be an array of strings");
  }

  const envelope: StageEnvelope = {
    status,
    summary: record.summary,
    artifacts: record.artifacts as string[],
  };

  if (record.fork_choice !== undefined) {
    if (
      !Array.isArray(record.fork_choice) ||
      !record.fork_choice.every((item) => typeof item === "string")
    ) {
      throw new EnvelopeError("fork_choice must be an array of strings");
    }
    envelope.fork_choice = record.fork_choice as string[];
  }

  if (record.clone_forks !== undefined) {
    envelope.clone_forks = parseCloneForks(record.clone_forks);
  }

  if (record.checklist_attestations !== undefined) {
    if (!Array.isArray(record.checklist_attestations)) {
      throw new EnvelopeError("checklist_attestations must be an array");
    }
    const ids = new Set<string>();
    envelope.checklist_attestations = record.checklist_attestations.map(
      (value, index) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new EnvelopeError(`checklist_attestations[${index}] must be an object`);
        }
        const attestation = value as Record<string, unknown>;
        if (typeof attestation.check_id !== "string" || attestation.check_id.trim() === "") {
          throw new EnvelopeError(`checklist_attestations[${index}].check_id must be a non-empty string`);
        }
        if (ids.has(attestation.check_id)) {
          throw new EnvelopeError(`checklist_attestations contains duplicate check_id "${attestation.check_id}"`);
        }
        ids.add(attestation.check_id);
        if (!Array.isArray(attestation.items) || !attestation.items.every((item) => typeof item === "string")) {
          throw new EnvelopeError(`checklist_attestations[${index}].items must be an array of strings`);
        }
        return { check_id: attestation.check_id, items: attestation.items as string[] };
      },
    );
  }

  if (record.payload !== undefined) {
    if (
      record.payload === null ||
      typeof record.payload !== "object" ||
      Array.isArray(record.payload)
    ) {
      throw new EnvelopeError("payload must be an object when present");
    }
    envelope.payload = record.payload as Record<string, unknown>;
  }

  if (record.stage_id !== undefined) {
    if (typeof record.stage_id !== "string") {
      throw new EnvelopeError("stage_id must be a string when present");
    }
    envelope.stage_id = record.stage_id;
  }

  if (record.notes !== undefined) {
    if (typeof record.notes !== "string") {
      throw new EnvelopeError("notes must be a string when present");
    }
    envelope.notes = record.notes;
  }

  return envelope;
}

export function isAdvancingEnvelope(envelope: StageEnvelope): boolean {
  return envelope.status === "success";
}
