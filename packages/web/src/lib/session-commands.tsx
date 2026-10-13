import type { ModelInfo, ModelRef, ModelThinkingLevel } from "@harness/protocol";
import { useCommandPalette, type CommandPage } from "./commands.tsx";
import { useHarness } from "./store.tsx";

type ConfigureModel = (model: ModelRef) => Promise<void>;
type ConfigureThinkingLevel = (level: ModelThinkingLevel) => Promise<void>;

/** One command per available model, grouped by provider, with the current one checked. */
export function buildModelPage(
	models: ModelInfo[],
	current: ModelRef | undefined,
	configureModel: ConfigureModel,
): CommandPage {
	return {
		kind: "commands",
		title: "Change model",
		placeholder: "Search models…",
		commands: models.map((model) => ({
			id: `model.${model.provider}.${model.id}`,
			title: model.name,
			group: model.providerName,
			detail: `${Math.round(model.contextWindow / 1000)}k context`,
			keywords: [model.provider, model.providerName, model.id, ...(model.reasoning ? ["reasoning"] : [])],
			current: current?.provider === model.provider && current.modelId === model.id,
			run: () => void configureModel({ provider: model.provider, modelId: model.id }),
		})),
	};
}

/** One command per thinking level the current model supports. */
export function buildThinkingPage(
	levels: readonly ModelThinkingLevel[],
	current: ModelThinkingLevel | undefined,
	configureThinkingLevel: ConfigureThinkingLevel,
): CommandPage {
	return {
		kind: "commands",
		title: "Change thinking level",
		placeholder: "Search levels…",
		commands: levels.map((level) => ({
			id: `thinking.${level}`,
			title: level,
			group: "Thinking level",
			current: level === current,
			run: () => void configureThinkingLevel(level),
		})),
	};
}

/** The model page, for the palette command and the composer chip. */
export function useModelPalette(): { page(): CommandPage; open(): void } {
	const { models, activeSession, configureModel } = useHarness();
	const { openPage } = useCommandPalette();
	const current = activeSession?.agent.model;
	return {
		page: () => buildModelPage(models, current, configureModel),
		open: () => openPage(buildModelPage(models, current, configureModel)),
	};
}

/** The thinking level page plus the levels of the current model, so callers can hide the chip. */
export function useThinkingPalette(): {
	levels: readonly ModelThinkingLevel[];
	page(): CommandPage;
	open(): void;
} {
	const { models, activeSession, configureThinkingLevel } = useHarness();
	const { openPage } = useCommandPalette();
	const current = activeSession?.agent.model;
	const info = models.find((model) => model.provider === current?.provider && model.id === current.modelId);
	const levels = info?.thinkingLevels ?? [];
	const level = activeSession?.agent.thinkingLevel;
	return {
		levels,
		page: () => buildThinkingPage(levels, level, configureThinkingLevel),
		open: () => openPage(buildThinkingPage(levels, level, configureThinkingLevel)),
	};
}
