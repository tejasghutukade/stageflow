import { fetchHealth, fetchRuns } from "../api";
import type { CatalogSource } from "./source";

export function createHttpSource(): CatalogSource {
  return {
    readListing: () => fetchRuns(),
    readCapacity: () => fetchHealth(),
  };
}
