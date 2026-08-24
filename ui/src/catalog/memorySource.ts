import type { CapacityHealth, RunSummary } from "../api";
import type { CatalogListing, CatalogSource } from "./source";

const DEFAULT_HEALTH: CapacityHealth = {
  ok: true,
  activeRunIds: [],
  activeCount: 0,
  maxConcurrent: 1,
  slotsAvailable: 1,
};

export type MemoryCatalogSource = CatalogSource & {
  listingReads: number;
  capacityReads: number;
};

export function createMemorySource(script: {
  listings: Array<RunSummary[] | Error>;
  health?: Array<CapacityHealth | Error>;
}): MemoryCatalogSource {
  let listingIndex = 0;
  let healthIndex = 0;
  const source: MemoryCatalogSource = {
    listingReads: 0,
    capacityReads: 0,
    async readListing(): Promise<CatalogListing> {
      source.listingReads += 1;
      const item = script.listings[listingIndex];
      listingIndex += 1;
      if (item === undefined) {
        throw new Error("memory source: no more listings");
      }
      if (item instanceof Error) throw item;
      return { runs: item };
    },
    async readCapacity(): Promise<CapacityHealth> {
      source.capacityReads += 1;
      const scripted = script.health;
      if (!scripted || scripted.length === 0) {
        return DEFAULT_HEALTH;
      }
      const item = scripted[Math.min(healthIndex, scripted.length - 1)];
      healthIndex += 1;
      if (item instanceof Error) throw item;
      return item;
    },
  };
  return source;
}
