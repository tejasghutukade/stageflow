import {
  EnvelopeError,
  type StageEnvelope,
} from "../types/envelope.js";

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
