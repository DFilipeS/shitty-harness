import type { ModelThinkingLevel } from "@harness/protocol";
import { useProviderPalette } from "../lib/provider-commands.tsx";
import { useHarness } from "../lib/store.tsx";

const selectClass =
	"max-w-52 rounded-md border border-line bg-panel px-2 py-1 text-base text-fg-soft outline-none hover:border-line-strong focus:border-fg-subtle sm:text-xs";

export function ModelPicker() {
	const { providers, models, activeSession, configureModel, configureThinkingLevel } = useHarness();
	const providersPalette = useProviderPalette();

	const configured = providers.filter(
		(provider) => provider.configured && models.some((model) => model.provider === provider.id),
	);

	if (configured.length === 0) {
		return (
			<button
				type="button"
				onClick={providersPalette.open}
				className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-fg-soft hover:border-fg-subtle"
			>
				Add a provider
			</button>
		);
	}

	const currentModel = activeSession?.agent.model;
	const providerId = currentModel?.provider ?? configured[0]?.id ?? "";
	const modelsForProvider = models.filter((model) => model.provider === providerId);
	const modelId = currentModel?.provider === providerId ? currentModel.modelId : (modelsForProvider[0]?.id ?? "");
	const selectedModel = modelsForProvider.find((model) => model.id === modelId);
	const thinkingLevels = selectedModel?.thinkingLevels ?? ["off"];
	const thinkingLevel = activeSession?.agent.thinkingLevel ?? "off";

	return (
		<div className="flex items-center gap-1.5 overflow-x-auto">
			<select
				className={selectClass}
				value={providerId}
				onChange={(event) => {
					const nextProvider = event.target.value;
					const first = models.find((model) => model.provider === nextProvider);
					if (first !== undefined) void configureModel({ provider: nextProvider, modelId: first.id });
				}}
				title="Provider"
			>
				{configured.map((provider) => (
					<option key={provider.id} value={provider.id}>
						{provider.name}
					</option>
				))}
			</select>

			<select
				className={selectClass}
				value={modelId}
				onChange={(event) => void configureModel({ provider: providerId, modelId: event.target.value })}
				title="Model"
			>
				{modelsForProvider.map((model) => (
					<option key={model.id} value={model.id}>
						{model.name}
					</option>
				))}
			</select>

			{thinkingLevels.length > 1 && (
				<select
					className={selectClass}
					value={thinkingLevel}
					onChange={(event) => void configureThinkingLevel(event.target.value as ModelThinkingLevel)}
					title="Thinking level"
				>
					{thinkingLevels.map((level) => (
						<option key={level} value={level}>
							{level}
						</option>
					))}
				</select>
			)}
		</div>
	);
}
