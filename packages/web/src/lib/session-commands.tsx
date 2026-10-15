import type { ReactNode } from "react";
import type { ImageModelInfo, ModelInfo, ModelRef, ModelThinkingLevel } from "@harness/protocol";
import { useCommandPalette, type CommandPage } from "./commands.tsx";
import { modelCapabilities } from "./models.ts";
import { useHarness } from "./store.tsx";
import { useDefaultTargetPalette } from "./target-commands.tsx";
import { BrainIcon, CpuIcon, FolderIcon, ImageIcon, WandIcon } from "../components/icons.tsx";

/** Capability icons for one model: reasoning, image input, and image generation. */
function modelBadges(model: ModelInfo): ReactNode | undefined {
	const badges = modelCapabilities(model).map((capability) => {
		switch (capability) {
			case "reasoning":
				return (
					<span key={capability} title="Reasoning" className="flex">
						<BrainIcon className="h-3.5 w-3.5" />
					</span>
				);
			case "image":
				return (
					<span key={capability} title="Image input" className="flex">
						<ImageIcon className="h-3.5 w-3.5" />
					</span>
				);
			case "imageGeneration":
				return (
					<span key={capability} title="Image generation" className="flex">
						<WandIcon className="h-3.5 w-3.5" />
					</span>
				);
		}
	});
	return badges.length === 0 ? undefined : badges;
}

type ConfigureModel = (model: ModelRef) => Promise<void>;
type ConfigureThinkingLevel = (level: ModelThinkingLevel) => Promise<void>;

/** The command-list page shape, so callers can add rows to a built page. */
type CommandList = Extract<CommandPage, { kind: "commands" }>;

/** One command per available model, grouped by provider, with the current one checked. */
export function buildModelPage(
	models: ModelInfo[],
	current: ModelRef | undefined,
	select: ConfigureModel,
	options: { title?: string; idPrefix?: string } = {},
): CommandList {
	return {
		kind: "commands",
		title: options.title ?? "Change model",
		placeholder: "Search models…",
		// Image-generation models are for `generate_image`; they are not offered as chat models.
		commands: models
			.filter((model) => !model.imageGeneration)
			.map((model) => ({
				id: `${options.idPrefix ?? "model."}${model.provider}.${model.id}`,
				title: model.name,
				group: model.providerName,
				badges: modelBadges(model),
				detail: `${Math.round(model.contextWindow / 1000)}k context`,
				keywords: [model.provider, model.providerName, model.id, ...(model.reasoning ? ["reasoning"] : [])],
				current: current?.provider === model.provider && current.modelId === model.id,
				run: () => void select({ provider: model.provider, modelId: model.id }),
			})),
	};
}

/** One command per thinking level the current model supports. */
export function buildThinkingPage(
	levels: readonly ModelThinkingLevel[],
	current: ModelThinkingLevel | undefined,
	select: ConfigureThinkingLevel,
	options: { title?: string; idPrefix?: string } = {},
): CommandList {
	return {
		kind: "commands",
		title: options.title ?? "Change thinking level",
		placeholder: "Search levels…",
		commands: levels.map((level) => ({
			id: `${options.idPrefix ?? "thinking."}${level}`,
			title: level,
			group: "Thinking level",
			current: level === current,
			run: () => void select(level),
		})),
	};
}

/** The model page plus "First available", which clears the stored default. */
export function buildDefaultModelPage(
	models: ModelInfo[],
	current: ModelRef | undefined,
	setDefaultModel: (model: ModelRef | null) => Promise<void>,
): CommandList {
	const page = buildModelPage(models, current, setDefaultModel, {
		title: "Default model",
		idPrefix: "default.model.",
	});
	return {
		...page,
		commands: [
			{
				id: "default.model.first",
				title: "First available",
				group: "Defaults",
				detail: "No default model",
				current: current === undefined,
				run: () => void setDefaultModel(null),
			},
			...page.commands,
		],
	};
}

/** The image models `generate_image` can drive, plus "First available" to clear the default. */
export function buildDefaultImageModelPage(
	models: readonly ImageModelInfo[],
	current: ModelRef | undefined,
	setDefaultModel: (model: ModelRef | null) => Promise<void>,
): CommandList {
	return {
		kind: "commands",
		title: "Default image model",
		placeholder: "Search image models…",
		commands: [
			{
				id: "default.image-model.first",
				title: "First available",
				group: "Defaults",
				detail: "No default image model",
				current: current === undefined,
				run: () => void setDefaultModel(null),
			},
			...models.map((model) => ({
				id: `default.image-model.${model.provider}.${model.id}`,
				title: model.name,
				group: model.providerName,
				detail: model.id,
				keywords: [model.provider, model.providerName, model.id],
				current: current?.provider === model.provider && current.modelId === model.id,
				run: () => void setDefaultModel({ provider: model.provider, modelId: model.id }),
			})),
		],
	};
}

/** The thinking page plus "Model default", which clears the stored level. */
export function buildDefaultThinkingPage(
	levels: readonly ModelThinkingLevel[],
	current: ModelThinkingLevel | undefined,
	setDefaultLevel: (level: ModelThinkingLevel | null) => Promise<void>,
): CommandList {
	const page = buildThinkingPage(levels, current, setDefaultLevel, {
		title: "Default thinking level",
		idPrefix: "default.thinking.",
	});
	return {
		...page,
		commands: [
			{
				id: "default.thinking.model",
				title: "Model default",
				group: "Defaults",
				detail: "Let the model decide",
				current: current === undefined,
				run: () => void setDefaultLevel(null),
			},
			...page.commands,
		],
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

/**
 * The defaults page: the model and thinking level new sessions start with. The thinking levels
 * come from the model a new session will actually use, so the list matches what gets applied.
 */
export function useDefaultsPalette(): { page(): CommandPage; open(): void } {
	const { models, imageModels, defaults, setDefaults } = useHarness();
	const { openPage } = useCommandPalette();
	const targetPalette = useDefaultTargetPalette();
	const defaultModel = defaults.model;
	const defaultInfo = models.find(
		(model) => model.provider === defaultModel?.provider && model.id === defaultModel.modelId,
	);
	const resolved = defaultInfo ?? models[0];
	const levels = resolved?.thinkingLevels ?? [];
	const defaultImageModel = defaults.imageModel;
	const imageInfo = imageModels.find(
		(model) => model.provider === defaultImageModel?.provider && model.id === defaultImageModel.modelId,
	);

	const page = (): CommandPage => ({
		kind: "commands",
		title: "Defaults",
		placeholder: "Search settings…",
		commands: [
			{
				id: "defaults.model",
				title: "Default model",
				group: "Defaults",
				detail: defaultInfo?.name ?? "First available",
				icon: <CpuIcon />,
				run: ({ pushPage }) =>
					pushPage(buildDefaultModelPage(models, defaultModel, (model) => setDefaults({ model }))),
			},
			{
				id: "defaults.thinking",
				title: "Default thinking level",
				group: "Defaults",
				detail: defaults.thinkingLevel ?? "Model default",
				icon: <BrainIcon />,
				run: ({ pushPage }) =>
					pushPage(
						buildDefaultThinkingPage(levels, defaults.thinkingLevel, (level) =>
							setDefaults({ thinkingLevel: level }),
						),
					),
			},
			{
				id: "defaults.target",
				title: "Default target",
				group: "Defaults",
				detail: defaults.target?.path ?? "Scratch directory",
				icon: <FolderIcon />,
				run: ({ pushPage }) => pushPage(targetPalette.page()),
			},
			{
				id: "defaults.image-model",
				title: "Default image model",
				group: "Defaults",
				detail: imageInfo?.name ?? "First available",
				icon: <WandIcon />,
				run: ({ pushPage }) =>
					pushPage(
						buildDefaultImageModelPage(imageModels, defaultImageModel, (model) =>
							setDefaults({ imageModel: model }),
						),
					),
			},
		],
	});

	return { page, open: () => openPage(page()) };
}
