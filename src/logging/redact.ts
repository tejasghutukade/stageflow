const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\b[A-Za-z_]*KEY[A-Za-z_]*\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{16,}['"]?/gi,
];

const REDACTED = "[redacted]";

export type RedactOptions = {
  patterns?: RegExp[];
  knownSecrets?: readonly string[];
};

function scrubString(
  value: string,
  patterns: RegExp[],
  knownSecrets: readonly string[],
): string {
  let out = value;
  for (const pattern of patterns) {
    out = out.replace(pattern, REDACTED);
  }
  for (const secret of knownSecrets) {
    if (secret.length === 0) continue;
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

function scrubValue(
  value: unknown,
  patterns: RegExp[],
  knownSecrets: readonly string[],
): unknown {
  if (typeof value === "string") {
    return scrubString(value, patterns, knownSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, patterns, knownSecrets));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = scrubValue(child, patterns, knownSecrets);
    }
    return out;
  }
  return value;
}

export function redact<T extends Record<string, unknown>>(
  record: T,
  options: RedactOptions = {},
): T {
  const patterns = options.patterns ?? SECRET_PATTERNS;
  const knownSecrets = options.knownSecrets ?? [];
  return scrubValue(record, patterns, knownSecrets) as T;
}
