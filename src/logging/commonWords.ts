/** Common words that must not be value-redacted even if length ≥ 8. */
export const COMMON_WORDS: ReadonlySet<string> = new Set([
  "password",
  "username",
  "localhost",
  "127.0.0.1",
  "true",
  "false",
  "undefined",
  "development",
  "production",
  "staging",
]);
