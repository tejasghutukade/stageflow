/** Lets only the most recently started load apply its result: `const current = guard(); ... if (current()) set(...)`. */
export function createLatestGuard(): () => () => boolean {
  let latest = 0;
  return () => {
    latest += 1;
    const mine = latest;
    return () => mine === latest;
  };
}
