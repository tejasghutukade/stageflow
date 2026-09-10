export function formatCostUsd(costUsd: number | undefined): string | null {
  if (costUsd === undefined) return null;
  return `$${costUsd.toFixed(4)}`;
}

export function CostBadge({ costUsd }: { costUsd?: number }) {
  const formatted = formatCostUsd(costUsd);
  if (!formatted) return null;
  return (
    <span className="chip chip--cost" aria-label={`cost ${formatted}`}>
      {formatted}
    </span>
  );
}
