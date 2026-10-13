import type { ProviderInfo } from "@harness/protocol";
import { KeyIcon, TrashIcon } from "../components/icons.tsx";
import { useCommandPalette, type Command, type CommandPage } from "./commands.tsx";
import { useHarness } from "./store.tsx";

type Configure = (providerId: string, apiKey: string | null) => Promise<void>;

/** Providers, configured first, each opening its own action page. */
export function buildProviderPage(providers: ProviderInfo[], configureProvider: Configure): CommandPage {
	const sorted = [...providers].sort(
		(a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name),
	);
	return {
		kind: "commands",
		title: "Model providers",
		placeholder: "Search providers…",
		commands: sorted.map((provider) => ({
			id: `provider.${provider.id}`,
			title: provider.name,
			group: provider.configured ? "Configured" : "Not configured",
			detail: provider.configured
				? (provider.authSource ?? "API key stored")
				: `${provider.modelCount} models`,
			keywords: [provider.id, "provider", provider.configured ? "configured" : "connect"],
			icon: <KeyIcon />,
			current: provider.configured,
			run: ({ pushPage }) => pushPage(buildProviderActions(provider, configureProvider)),
		})),
	};
}

/** Set, replace, or remove the credential of one provider. */
function buildProviderActions(provider: ProviderInfo, configureProvider: Configure): CommandPage {
	const commands: Command[] = [
		{
			id: `provider.${provider.id}.set`,
			title: provider.configured ? "Replace API key…" : "Set API key…",
			group: "Actions",
			keywords: ["connect", "token", "credential", "key"],
			icon: <KeyIcon />,
			run: ({ prompt }) =>
				prompt({
					title: `${provider.configured ? "Replace" : "Set"} API key for ${provider.name}`,
					placeholder: "Paste the API key",
					secret: true,
					onSubmit: (value) => {
						const key = value.trim();
						if (key === "") return false;
						void configureProvider(provider.id, key);
					},
				}),
		},
	];
	if (provider.configured) {
		commands.push({
			id: `provider.${provider.id}.remove`,
			title: "Remove API key",
			group: "Actions",
			keywords: ["disconnect", "delete", "credential"],
			icon: <TrashIcon />,
			run: () => void configureProvider(provider.id, null),
		});
	}
	return {
		kind: "commands",
		title: provider.name,
		placeholder: "Choose an action…",
		commands,
	};
}

/** Opens the provider flow from anywhere, e.g. the sidebar gear or "Add a provider". */
export function useProviderPalette(): { page(): CommandPage; open(): void } {
	const { providers, configureProvider } = useHarness();
	const { openPage } = useCommandPalette();
	return {
		page: () => buildProviderPage(providers, configureProvider),
		open: () => openPage(buildProviderPage(providers, configureProvider)),
	};
}
