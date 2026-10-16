const KEY = "stageflow-chat-visitor";
const VALID = /^[A-Za-z0-9_-]{16,64}$/;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

let memo: string | null = null;

export function newVisitorId(random: () => string = () => crypto.randomUUID()): string {
  const id = random().replace(/[^A-Za-z0-9_-]/g, "");
  return VALID.test(id) ? id : `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`.slice(0, 32).padEnd(16, "0");
}

/** The browser's visitor id: created once and remembered. Storage can be blocked, so it falls back to this page load. */
export function getVisitorId(storage?: StorageLike | null): string {
  let store: StorageLike | null = null;
  try {
    store = storage === undefined ? window.localStorage : storage;
  } catch {
    store = null;
  }
  try {
    const saved = store?.getItem(KEY);
    if (saved && VALID.test(saved)) return saved;
  } catch {
    // fall through to a fresh id
  }
  if (storage === undefined && memo) return memo;
  const id = newVisitorId();
  try {
    store?.setItem(KEY, id);
  } catch {
    // remembered for this page load only
  }
  if (storage === undefined) memo = id;
  return id;
}

export function resetVisitorMemoForTests(): void {
  memo = null;
}
