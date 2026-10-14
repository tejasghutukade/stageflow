export { ChannelError, type ChannelErrorCode, type ChannelErrorDetail } from "./errors.js";
export { CONNECTIONS_FILE_NAME, ChannelRegistry, type ChannelRegistryOptions } from "./registry.js";
export { loadConnectionsFile, parseConnectionsYaml, type ConnectionsFile } from "./config.js";
export { isSecretRef, redactSecrets, resolveSecretRef, resolveSecrets } from "./secrets.js";
export type * from "./types.js";
export {
  MAX_CHANNEL_TARGETS, MAX_CHANNELS_PER_STAGE, MAX_STAGE_CHANNELS, channelLimitMessage, setStageChannelLimitForTests, stageChannelLimit, channelKey, channelTarget, mergeChannelDefaults, parseChannels,
  validateStageChannels, type ParsedChannels, type StageChannelIssue,
} from "./stageChannels.js";
export {
  ChannelHost, MAX_MESSAGE_TEXT, channelFault, channelHostFor, channelsWorkerEnvironment, releaseChannelHost,
  stageChannels, validateStageChannelConnections, workerStageChannels,
  type ChannelSendInput, type ChannelSendResult, type StageChannels,
} from "./host.js";
export { ChannelSends, type ChannelSendRecord } from "./ledger.js";
export { channelProviders, registerChannelProvider, unregisterChannelProvider } from "./providers.js";
export { ChannelHealthMonitor, DEFAULT_HEALTH_INTERVAL_MS, type ChannelHealthOptions } from "./health.js";
