import type { CompactionStrategy } from "../types.js";
import { piSummarize } from "./pi.js";

export const FOCUS_INSTRUCTIONS =
  "Keep exact identifiers, counts, numbers, timestamps, URLs, file paths and error messages verbatim, never paraphrase them. " +
  "Record every failure and every dead end (what was tried and why it failed, so it is not retried). " +
  "Record operator decisions and user preferences and constraints word for word. " +
  "State the in-flight state, the exact next step, and the final deliverable still owed. " +
  "Never copy secrets, cookies or tokens; say only that one existed.";

export const focus: CompactionStrategy = {
  id: "focus",
  description: "Pi default prompt plus a focus line: exact values, failures and dead ends, in-flight state, next step, deliverable.",
  summarize: (input) => piSummarize(input, FOCUS_INSTRUCTIONS),
};
