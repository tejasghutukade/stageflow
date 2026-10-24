import { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Settings for every Pi session Stageflow starts. Auto-compaction is always on
 * and not configurable: a long session compacts at the threshold, and recovers
 * once from a provider context-overflow, instead of failing.
 */
export function createPiSettingsManager(): SettingsManager {
  return SettingsManager.inMemory({ compaction: { enabled: true } });
}
