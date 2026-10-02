export const LOCAL_BROWSER_SCOPE = "local";

export interface ProfileKey {
  scope: string;
  name: string;
}

export interface ProfileHandle {
  key: ProfileKey;
  profileDir: string;
  stateDir: string;
}

export interface ProfileStore {
  open(key: ProfileKey): Promise<ProfileHandle>;
  list(scope: string): Promise<string[]>;
  delete(key: ProfileKey): Promise<void>;
  deleteScope(scope: string): Promise<void>;
}

export class InvalidProfileKeyError extends Error {
  readonly code = "invalid_profile_key";

  constructor(message: string) {
    super(message);
    this.name = "InvalidProfileKeyError";
  }
}

const MAX_SEGMENT_LENGTH = 64;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateSegment(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidProfileKeyError(`Profile ${label} must be a non-empty string`);
  }
  if (value.length > MAX_SEGMENT_LENGTH) {
    throw new InvalidProfileKeyError(
      `Profile ${label} must be at most ${MAX_SEGMENT_LENGTH} characters`,
    );
  }
  if (!SEGMENT_PATTERN.test(value) || value.includes("..")) {
    throw new InvalidProfileKeyError(
      `Profile ${label} "${value}" may only use letters, digits, ".", "_" and "-", must start with a letter or digit, and must not contain ".."`,
    );
  }
  return value;
}

export function validateProfileName(name: unknown): string {
  return validateSegment("name", name);
}

export function validateProfileScope(scope: unknown): string {
  return validateSegment("scope", scope);
}

export function validateProfileKey(key: ProfileKey): ProfileKey {
  return {
    scope: validateProfileScope(key?.scope),
    name: validateProfileName(key?.name),
  };
}
