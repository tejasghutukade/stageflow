import { redactString } from "../logging/redact.js";

/**
 * Everything the compaction code removes before text reaches a summarizer, a pinned fact, a directive or the
 * working state. Stricter than redactString: it also catches key=value forms, cookies and session ids.
 * It can over-redact harmless text such as `token_count=5`; callers that store model-written text say so.
 */
export const SECRET_KEY_RE = /secret|token|passw|pwd|api[_-]?key|auth|credential|bearer|cookie|private|session|\bsid\b|csrf|xsrf|jwt|signature/i;
const EXTRA_SECRET_RES: RegExp[] = [
  /\b(?:api[_-]?key|secret|token|password|passwd|authorization|bearer)\b["']?\s*[:=]\s*["']?[^\s"',;]+/gi,
  /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi,
  /\b(?:Set-)?Cookie:[^\n]*/gi,
  /\b(?:session|sess|sid|csrf|xsrf|jsessionid|phpsessid)[\w-]*=[^\s;,"']+/gi,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[\w-]{8,}/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g,
  /[?&](?:token|key|api_?key|access_token|auth|signature|sig)=[^\s&"']+/gi,
];

export function scrubSecrets(text: string): string {
  let out = redactString(text);
  for (const re of EXTRA_SECRET_RES) {
    re.lastIndex = 0;
    out = out.replace(re, "[redacted]");
  }
  return out;
}
