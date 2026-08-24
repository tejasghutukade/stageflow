import type { CapacityHealth, RunSummary } from "../api";

export type CatalogListing = {
  runs: RunSummary[];
};

export type CatalogSnapshot = {
  runs: RunSummary[];
  health: CapacityHealth | null;
};

export type CatalogSource = {
  readListing(): Promise<CatalogListing>;
  readCapacity(): Promise<CapacityHealth>;
};
