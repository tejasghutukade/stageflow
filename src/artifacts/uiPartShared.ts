export const UI_PART_SCHEMA_VERSION = 1 as const;
export const UI_PART_FALLBACK_TEXT_MAX_CHARS = 2_000;

export const uiPartFallbackSchema = {
  text: { max: UI_PART_FALLBACK_TEXT_MAX_CHARS },
} as const;

type WithFallback = { fallback: { text: string; url: string } };

export function capFallbackText<T extends WithFallback>(part: T): T {
  const { text } = part.fallback;
  if (text.length <= UI_PART_FALLBACK_TEXT_MAX_CHARS) return part;
  return {
    ...part,
    fallback: { ...part.fallback, text: text.slice(0, UI_PART_FALLBACK_TEXT_MAX_CHARS) },
  };
}