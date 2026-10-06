import { useEffect, useState } from "react";

const KEY = "sf.pinnedPipelines.v1";

export function readPinnedPipelines(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function usePinnedPipelines(): string[] {
  const [pins, setPins] = useState(readPinnedPipelines);

  useEffect(() => {
    const onStorage = () => setPins(readPinnedPipelines());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return pins;
}
