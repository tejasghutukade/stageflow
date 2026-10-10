import type { ImageSize, ViewRect } from "./types";

const MAX_COORDINATE = 20_000;

export function mapPoint(
  client: { clientX: number; clientY: number },
  rect: ViewRect,
  image: ImageSize | null,
): { x: number; y: number } | null {
  if (image === null || image.width <= 0 || image.height <= 0) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = ((client.clientX - rect.left) * image.width) / rect.width;
  const y = ((client.clientY - rect.top) * image.height) / rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const clamp = (v: number, max: number) => Math.round(Math.min(Math.max(v, 0), Math.min(max, MAX_COORDINATE)));
  return { x: clamp(x, image.width), y: clamp(y, image.height) };
}
