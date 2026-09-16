const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\b[A-Za-z_]*KEY[A-Za-z_]*\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{16,}['"]?/gi,
];

/** Scrub common secret-shaped substrings before text is persisted or returned. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}
