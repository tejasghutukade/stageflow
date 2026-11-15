/**
 * `agent/models.json` holds the model routing a workspace relies on (provider pins, base URLs, model lists), and it can
 * also hold keys: Pi reads `apiKey` and request `headers` from it. A default archive keeps the routing and drops anything
 * that can be a credential, so a restore into a new workspace behaves the same without carrying a secret. A key name that
 * ends in key, token, secret, password, credential or authorization, and any `headers` object, is removed at every depth.
 * `maxTokens` and `contextWindow` are numbers about the model and stay.
 */
const SECRET_NAME = /(key|token|secret|password|passwd|credential|authorization)$/i;
const HEADERS_NAME = /^headers?$/i;

const MAX_MODELS_JSON_BYTES = 4 * 1024 * 1024;

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_NAME.test(name) || HEADERS_NAME.test(name)) continue;
      out[name] = strip(inner);
    }
    return out;
  }
  return value;
}

/** The file's text without credential fields, or undefined when it is too large or not a JSON object. */
export function redactModelsJson(text: string): string | undefined {
  if (Buffer.byteLength(text, "utf8") > MAX_MODELS_JSON_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return `${JSON.stringify(strip(parsed), null, 2)}\n`;
}
