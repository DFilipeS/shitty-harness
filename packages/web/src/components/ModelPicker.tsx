import type { ModelThinkingLevel } from "@harness/protocol";
import { useHarness } from "../lib/store.tsx";

const selectClass =
	"max-w-52 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-base text-zinc-300 outline-none hover:border-zinc-700 focus:border-zinc-500 sm:text-xs";

export function ModelPicker() {
	const { providers, models, activeSession, configureModel, configureThinkingLevel, openProviderDialog } = useHarness();

	const configured = providers.filter(
		(provider) => provider.configured && models.some((model) => model.provider === provider.id),
	);

	if (configured.length === 0) {
		return (
			<button
				type="button"
				onClick={openProviderDialog}
				className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500"
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
