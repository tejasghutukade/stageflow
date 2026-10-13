export function providerRowLabel(providerIds: string[]): string {
  if (providerIds.length === 0) return "No providers";
  if (providerIds.length <= 2) {
    return providerIds.join(" · ");
  }
  const head = providerIds.slice(0, 2).join(" · ");
  return `${head} · +${providerIds.length - 2}`;
}

export function providerConnectedLabel(count: number): string {
  if (count <= 0) return "No providers";
  if (count === 1) return "1 connected";
  return `${count} connected`;
}
