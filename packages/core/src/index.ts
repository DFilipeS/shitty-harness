export { loadConfig, saveConfig, emptyConfig, type AppConfig, type ProviderConfig, type DefaultTargetConfig } from "./config.ts";
export { ConfigCredentialStore } from "./credentials.ts";
export { FileModelsStore } from "./models-store.ts";
export { ProviderManager, type ProviderManagerOptions, type Providers } from "./providers.ts";
export {
	DEFAULT_CATALOG_BASE_URL,
	withRemoteCatalog,
	type CatalogRefreshStatus,
	type RemoteCatalogOptions,
} from "./remote-catalog.ts";
export { SessionIndex, type SessionIndexEntry, type SessionIndexState } from "./session-index.ts";
export { lazyEnvironment, type EnvironmentFactory } from "./environment.ts";
export {
	createTargetSection,
	resolveTarget,
	scratchPath,
	SessionTargetDoc,
	TargetChangeEntry,
	targetPrompt,
	type ResolvedTarget,
	type SessionTargetState,
	type TargetChangeData,
	type TargetResolutionOptions,
} from "./targets.ts";
export { ServiceError } from "./errors.ts";
export {
	HarnessService,
	type HarnessServiceDependencies,
	type ProvidersState,
	type ServiceEvent,
} from "./service.ts";
