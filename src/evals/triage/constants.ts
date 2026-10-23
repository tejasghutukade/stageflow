export const TRIAGE_BUCKETS = ["agent_wrong", "grader_wrong", "case_wrong", "unclear"] as const;
export type TriageBucket = (typeof TRIAGE_BUCKETS)[number];

export const TRIAGE_SOURCES = ["jev", "judge"] as const;
export type TriageSource = (typeof TRIAGE_SOURCES)[number];

export const SUGGESTION_STATUSES = ["pending", "accepted", "dismissed"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const FAILURE_TYPES_BY_KIND = {
  agent: [
    "missing_tool_call",
    "unneeded_tool_call",
    "wrong_or_missing_fact",
    "policy_violation",
    "tone",
    "ungrounded_claim",
    "off_topic",
    "no_handoff",
    "other",
  ],
  stage: ["wrong_value", "missing_field", "schema_invalid", "policy_violation", "ungrounded_claim", "tone", "other"],
} as const satisfies Record<"agent" | "stage", readonly string[]>;

/** Pinned System One model id; the alias `jev-latest` moves and is never used. Recorded on every suggestion. */
export const JEV_MODEL_ID = "jev-1.13.0";
export const JEV_BASE_URL = "https://api.typesafe.ai";
export const JEV_PRICE_INPUT_PER_MILLION_USD = 0.042;

/** Below this bucket confidence (or for `unclear`) a suggestion is low confidence and excluded from bulk accept. */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;
export const TRIAGE_STATE_MAX_CHARS = 24_000;
export const TRIAGE_CONCURRENCY = 4;
export const TRIAGE_DEFAULT_LIMIT = 200;
export const TRIAGE_MAX_LIMIT = 1_000;
export const JEV_MAX_RETRIES = 4;
export const JEV_BACKOFF_BASE_MS = 500;
export const BUCKET_TAG_PREFIX = "bucket:";

export const TYPESAFE_PROVIDER_ID = "typesafe";
/** Env names tried after the stored `typesafe` provider credential, in order; the first one set wins. */
export const TYPESAFE_KEY_ENV_NAMES = ["STAGEFLOW_PROVIDER_TYPESAFE_API_KEY", "TYPESAFE_API_KEY", "JEV_API_KEY"] as const;
