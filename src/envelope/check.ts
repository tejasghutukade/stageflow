import {
  EnvelopeError,
  type StageEnvelope,
} from "../types/envelope.js";

function qualifyEnvelopeMessage(pathPrefix: string, message: string): string {
  if (!pathPrefix) {
    return message;
  }
  if (message === "envelope must be an object") {
    return `${pathPrefix} must be an object`;
  }
  return `${pathPrefix}.${message}`;
}

export function assertRequiredEnvelope(
  value: unknown,
  pathPrefix: string = "",
): StageEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EnvelopeError(
      qualifyEnvelopeMessage(pathPrefix, "envelope must be an object"),
    );
  }

  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "success" && status !== "failure") {
    throw new EnvelopeError(
      qualifyEnvelopeMessage(
        pathPrefix,
        'status must be "success" or "failure"',
      ),
    );
  }

  if (typeof record.summary !== "string" || record.summary.trim() === "") {
    throw new EnvelopeError(
      qualifyEnvelopeMessage(pathPrefix, "summary must be a non-empty string"),
    );
  }

  if (!("artifacts" in record)) {
    throw new EnvelopeError(
      qualifyEnvelopeMessage(pathPrefix, "artifacts field is required"),
    );
  }
  if (!Array.isArray(record.artifacts)) {
    throw new EnvelopeError(
      qualifyEnvelopeMessage(pathPrefix, "artifacts must be an array"),
    );
  }
  if (!record.artifacts.every((item) => typeof item === "string")) {
    throw new EnvelopeError(
      qualifyEnvelopeMessage(
        pathPrefix,
        "artifacts must be an array of strings",
      ),
    );
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
      throw new EnvelopeError(
        qualifyEnvelopeMessage(
          pathPrefix,
          "fork_choice must be an array of strings",
        ),
      );
    }
    envelope.fork_choice = record.fork_choice as string[];
  }

  if (record.clone_forks !== undefined) {
    throw new EnvelopeError(
      qualifyEnvelopeMessage(
        pathPrefix,
        '"clone_forks" is no longer supported — use a Clone Chain instead',
      ),
    );
  }

  if (record.feedback_loop !== undefined) {
    if (
      record.feedback_loop === null ||
      typeof record.feedback_loop !== "object" ||
      Array.isArray(record.feedback_loop)
    ) {
      throw new EnvelopeError(
        qualifyEnvelopeMessage(pathPrefix, "feedback_loop must be an object"),
      );
    }
    const feedbackLoop = record.feedback_loop as Record<string, unknown>;
    if (feedbackLoop.action === "continue") {
      for (const key of Object.keys(feedbackLoop)) {
        if (key !== "action" && key !== "target") {
          throw new EnvelopeError(
            qualifyEnvelopeMessage(pathPrefix, `feedback_loop: unknown key "${key}"`),
          );
        }
      }
      if (feedbackLoop.target !== undefined) {
        throw new EnvelopeError(
          qualifyEnvelopeMessage(pathPrefix, "feedback_loop.target is not allowed for action continue"),
        );
      }
      envelope.feedback_loop = { action: "continue" };
    } else if (feedbackLoop.action === "send_back") {
      for (const key of Object.keys(feedbackLoop)) {
        if (key !== "action" && key !== "target") {
          throw new EnvelopeError(
            qualifyEnvelopeMessage(pathPrefix, `feedback_loop: unknown key "${key}"`),
          );
        }
      }
      if (typeof feedbackLoop.target !== "string" || feedbackLoop.target.trim() === "") {
        throw new EnvelopeError(
          qualifyEnvelopeMessage(pathPrefix, "feedback_loop.target must be a non-empty string for action send_back"),
        );
      }
      envelope.feedback_loop = { action: "send_back", target: feedbackLoop.target };
    } else {
      throw new EnvelopeError(
        qualifyEnvelopeMessage(pathPrefix, 'feedback_loop.action must be "continue" or "send_back"'),
      );
    }
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
      throw new EnvelopeError(
        qualifyEnvelopeMessage(
          pathPrefix,
          "payload must be an object when present",
        ),
      );
    }
    envelope.payload = record.payload as Record<string, unknown>;
  }

  if (record.stage_id !== undefined) {
    if (typeof record.stage_id !== "string") {
      throw new EnvelopeError(
        qualifyEnvelopeMessage(
          pathPrefix,
          "stage_id must be a string when present",
        ),
      );
    }
    envelope.stage_id = record.stage_id;
  }

  if (record.notes !== undefined) {
    if (typeof record.notes !== "string") {
      throw new EnvelopeError(
        qualifyEnvelopeMessage(pathPrefix, "notes must be a string when present"),
      );
    }
    envelope.notes = record.notes;
  }

  return envelope;
}

export function isAdvancingEnvelope(envelope: StageEnvelope): boolean {
  return envelope.status === "success";
}
