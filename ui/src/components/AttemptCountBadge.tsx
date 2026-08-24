export function formatAttemptCount(count: number | undefined): string | null {
  if (count === undefined || count <= 1) return null;
  return `×${count}`;
}

export function AttemptCountBadge({ count }: { count?: number }) {
  const formatted = formatAttemptCount(count);
  if (!formatted) return null;
  return (
    <span className="chip chip--attempt" aria-label={`${count} attempts`}>
      {formatted}
    </span>
  );
}
