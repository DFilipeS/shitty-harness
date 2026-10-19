import type {
	ProviderTemplateInfo,
	TemplateInfo,
	TemplateRecipeInput,
	TemplatesState,
} from "@harness/protocol";
import {
	CheckIcon,
	FilePlusIcon,
	FolderIcon,
	LayersIcon,
	PencilIcon,
	PlusIcon,
	RefreshIcon,
	SlidersIcon,
	TerminalIcon,
	TrashIcon,
	WandIcon,
	WrenchIcon,
} from "../components/icons.tsx";
import { useCommandPalette, type Command, type CommandPage } from "./commands.tsx";
import { useHarness } from "./store.tsx";

/** How one template's state reads in the palette. */
function stateLabel(template: TemplateInfo): string {
	switch (template.state) {
		case "draft":
			return "not built";
		case "building":
			return "building…";
		case "ready":
			return "ready";
		case "stale":
			return "built, recipe changed";
		case "failed":
			return "build failed";
		case "missing":
			return "missing in E2B";
	}
}

function sourceLabel(template: TemplateInfo): string {
	if (template.source.kind === "template") return `from ${template.source.name}`;
	if (template.source.kind === "image") return `from ${template.source.image}`;
	return "from the E2B base image";
}

function errorMessageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The short name of a provider template name: the last path segment, without its tag. */
export function templateShortName(name: string): string {
	const colon = name.indexOf(":");
	const withoutTag = colon === -1 ? name : name.slice(0, colon);
	const slash = withoutTag.lastIndexOf("/");
	return slash === -1 ? withoutTag : withoutTag.slice(slash + 1);
}

/**
 * The template picker shared by the sandbox defaults and the new-sandbox flow. It only offers
 * templates that can actually start a sandbox: ready or stale harness templates, the provider's
 * own default, and any other template the provider knows about. Draft, building, failed, and
 * missing templates stay on the Templates page, where their state is visible.
 */
export function buildTemplatePickerPage(options: {
	idPrefix: string;
	title?: string;
	templates: TemplateInfo[];
	other: ProviderTemplateInfo[];
	/** The template that applies now; undefined is the provider default. */
	current?: string;
	/** `null` selects the provider default. */
	select(template: string | null): void;
}): CommandPage {
	const pickable = options.templates.filter(
		(template) => template.state === "ready" || template.state === "stale",
	);
	const known = new Set(options.templates.map((template) => template.name));
	const others = options.other
		.map((template) => ({
			template,
			name: templateShortName(template.names[0] ?? template.templateId),
		}))
		.filter((entry) => !known.has(entry.name));
	return {
		kind: "commands",
		title: options.title ?? "Sandbox template",
		placeholder: "Search templates…",
		commands: [
			{
				id: `${options.idPrefix}.default`,
				title: "Provider default",
				group: "Base",
				detail: `The ${options.current === undefined ? "current choice" : "provider's own image"}`,
				icon: <TerminalIcon />,
				current: options.current === undefined,
				run: () => options.select(null),
			},
			...pickable.map((template): Command => ({
				id: `${options.idPrefix}.template.${template.name}`,
				title: template.name,
				group: "Sandbox templates",
				detail: `${stateLabel(template)}${template.description === undefined ? "" : ` · ${template.description}`}`,
				icon: <LayersIcon />,
				current: options.current === template.name,
				run: () => options.select(template.name),
			})),
			...others.map((entry): Command => ({
				id: `${options.idPrefix}.other.${entry.template.templateId}`,
				title: entry.name,
				group: "Other E2B templates",
				detail:
					entry.template.buildStatus === undefined
						? "in this E2B project"
						: `${entry.template.buildStatus} · in this E2B project`,
				current: options.current === entry.name,
				run: () => options.select(entry.name),
			})),
			{
				id: `${options.idPrefix}.name`,
				title: "Use a name…",
				group: "Custom",
				detail: "Any template in this E2B project",
				icon: <SlidersIcon />,
				run: ({ prompt }) =>
					prompt({
						title: "Template name",
						placeholder: "my-template",
						onSubmit: (value) => {
							const name = value.trim();
							if (name === "") return false;
							options.select(name);
						},
					}),
			},
		],
	};
}

/** The palette rows and flows for sandbox templates: create, edit, and build recipes. */
export function useTemplatesPalette(): { page(): CommandPage; open(): void } {
	const {
		templates,
		templatesDefault,
		templatesOther,
		templatesProviderName,
		templatesConfigured,
		refreshTemplates,
		createTemplate,
		createStarterTemplate,
		updateTemplate,
		buildTemplate,
		templateLogs,
		removeTemplate,
		deleteTemplate,
		deleteProviderTemplate,
		setSandboxSettings,
	} = useHarness();
	const { openPage } = useCommandPalette();

	/** The recipe a change produces, keeping the fields the change does not touch. */
	const recipeOf = (
		template: TemplateInfo,
		change: Partial<TemplateRecipeInput>,
	): TemplateRecipeInput => ({
		...(template.description === undefined ? {} : { description: template.description }),
		source: template.source,
		run: template.run,
		...change,
	});

	/** Replace the open page with the template page for `name` in a fresh state. */
	const showTemplate = (
		state: TemplatesState | undefined,
		name: string,
		replacePage: (page: CommandPage) => void,
	): void => {
		const fresh = state?.templates.find((template) => template.name === name);
		if (fresh !== undefined) replacePage(templatePage(fresh));
	};

	const logPage = (name: string): CommandPage => ({
		kind: "log",
		title: `Build log: ${name}`,
		load: async () => {
			const result = await templateLogs(name);
			return result ?? { lines: ["Could not read the build log."], done: true };
		},
	});

	const basePage = (template: TemplateInfo): CommandPage => ({
		kind: "commands",
		title: `Base: ${template.name}`,
		placeholder: "Search bases…",
		commands: [
			{
				id: "template.base.default",
				title: "E2B base image",
				group: "Base",
				detail: "The provider's default image",
				icon: <TerminalIcon />,
				current: template.source.kind === "default",
				keepOpen: true,
				run: async ({ replacePage }) => {
					showTemplate(
						await updateTemplate(
							template.name,
							recipeOf(template, { source: { kind: "default" } }),
						),
						template.name,
						replacePage,
					);
				},
			},
			...templates
				.filter((candidate) => candidate.name !== template.name)
				.map((candidate): Command => ({
					id: `template.base.${candidate.name}`,
					title: candidate.name,
					group: "Sandbox templates",
					detail: stateLabel(candidate),
					icon: <LayersIcon />,
					current: template.source.kind === "template" && template.source.name === candidate.name,
					keepOpen: true,
					run: async ({ replacePage }) => {
						showTemplate(
							await updateTemplate(
								template.name,
								recipeOf(template, { source: { kind: "template", name: candidate.name } }),
							),
							template.name,
							replacePage,
						);
					},
				})),
			{
				id: "template.base.template-name",
				title: "Another template by name…",
				group: "Base",
				detail: "Any template in this E2B project",
				icon: <SlidersIcon />,
				run: ({ prompt, replacePage }) =>
					prompt({
						title: "Template name",
						placeholder: "my-template",
						returnToPage: true,
						onSubmit: async (value) => {
							const name = value.trim();
							if (name === "") return false;
							showTemplate(
								await updateTemplate(
									template.name,
									recipeOf(template, { source: { kind: "template", name } }),
								),
								template.name,
								replacePage,
							);
						},
					}),
			},
			{
				id: "template.base.image",
				title: "A Docker image…",
				group: "Base",
				detail: template.source.kind === "image" ? template.source.image : "e.g. node:22",
				icon: <FolderIcon />,
				run: ({ prompt, replacePage }) =>
					prompt({
						title: "Docker image",
						placeholder: "node:22",
						returnToPage: true,
						onSubmit: async (value) => {
							const image = value.trim();
							if (image === "") return false;
							showTemplate(
								await updateTemplate(
									template.name,
									recipeOf(template, { source: { kind: "image", image } }),
								),
								template.name,
								replacePage,
							);
						},
					}),
			},
		],
	});

	const commandPage = (template: TemplateInfo, index: number): CommandPage => {
		const command = template.run[index] ?? "";
		const write = async (run: string[]): Promise<void> => {
			await updateTemplate(template.name, recipeOf(template, { run }));
		};
		return {
			kind: "commands",
			title: `Command ${index + 1}`,
			placeholder: "Actions…",
			commands: [
				{
					id: "template.command.edit",
					title: "Edit…",
					group: "Command",
					icon: <PencilIcon />,
					run: ({ prompt, replacePage }) =>
						prompt({
							title: "Command",
							initialValue: command,
							returnToPage: true,
							onSubmit: async (value) => {
								const next = value.trim();
								if (next === "") return false;
								const run = [...template.run];
								run[index] = next;
								showTemplate(
									await updateTemplate(template.name, recipeOf(template, { run })),
									template.name,
									replacePage,
								);
							},
						}),
				},
				{
					id: "template.command.up",
					title: "Move up",
					group: "Command",
					keepOpen: true,
					when: () => index > 0,
					run: async ({ replacePage }) => {
						const run = [...template.run];
						const previous = run[index - 1];
						const current = run[index];
						if (previous === undefined || current === undefined) return;
						run[index - 1] = current;
						run[index] = previous;
						showTemplate(
							await updateTemplate(template.name, recipeOf(template, { run })),
							template.name,
							replacePage,
						);
					},
				},
				{
					id: "template.command.down",
					title: "Move down",
					group: "Command",
					keepOpen: true,
					when: () => index < template.run.length - 1,
					run: async ({ replacePage }) => {
						const run = [...template.run];
						const next = run[index + 1];
						const current = run[index];
						if (next === undefined || current === undefined) return;
						run[index + 1] = current;
						run[index] = next;
						showTemplate(
							await updateTemplate(template.name, recipeOf(template, { run })),
							template.name,
							replacePage,
						);
					},
				},
				{
					id: "template.command.remove",
					title: "Remove",
					group: "Danger",
					icon: <TrashIcon />,
					keepOpen: true,
					run: async ({ replacePage }) => {
						const run = template.run.filter((_command, position) => position !== index);
						showTemplate(
							await updateTemplate(template.name, recipeOf(template, { run })),
							template.name,
							replacePage,
						);
					},
				},
			],
		};
	};

	const commandsPage = (template: TemplateInfo): CommandPage => ({
		kind: "commands",
		title: `Commands: ${template.name}`,
		placeholder: "Commands…",
		commands: [
			{
				id: "template.command.add",
				title: "Add command…",
				group: "Commands",
				detail: "Runs as root during the build",
				icon: <PlusIcon />,
				run: ({ prompt, replacePage }) =>
					prompt({
						title: "New command",
						placeholder: "apt-get install -y git",
						returnToPage: true,
						onSubmit: async (value) => {
							const command = value.trim();
							if (command === "") return false;
							const state = await updateTemplate(
								template.name,
								recipeOf(template, { run: [...template.run, command] }),
							);
							showTemplate(state, template.name, replacePage);
						},
					}),
			},
			...template.run.map((command, index): Command => ({
				id: `template.command.${index}`,
				title: command,
				group: "Commands",
				detail: `#${index + 1}`,
				run: ({ pushPage }) => pushPage(commandPage(template, index)),
			})),
		],
	});

	/** A confirmation page: one action and a way back. */
	const confirmPage = (
		title: string,
		action: string,
		detail: string,
		run: () => void,
	): CommandPage => ({
		kind: "commands",
		title,
		placeholder: "Confirm…",
		commands: [
			{ id: "confirm.run", title: action, group: "Confirm", detail, icon: <TrashIcon />, run },
			{ id: "confirm.cancel", title: "Cancel", group: "Confirm", run: () => {} },
		],
	});

	/** A template the harness does not manage; only the provider knows about it. */
	const otherTemplatePage = (template: ProviderTemplateInfo): CommandPage => {
		const name = templateShortName(template.names[0] ?? template.templateId);
		return {
			kind: "commands",
			title: name,
			placeholder: "Actions…",
			commands: [
				{
					id: "other.delete",
					title: "Delete in E2B…",
					group: "Danger",
					detail: "Cannot be undone",
					icon: <TrashIcon />,
					run: ({ pushPage }) =>
						pushPage(
							confirmPage(
								"Delete template",
								`Delete ${name} in E2B`,
								"Cannot be undone",
								() => void deleteProviderTemplate(template.templateId),
							),
						),
				},
				{
					id: "other.back",
					title: "Back to templates",
					group: "Templates",
					icon: <CheckIcon />,
					run: ({ replacePage }) => replacePage(page()),
				},
			],
		};
	};

	const templatePage = (
		template: TemplateInfo,
		isDefault = templatesDefault === template.name,
	): CommandPage => ({
		kind: "commands",
		title: template.name,
		placeholder: "Actions…",
		commands: [
			{
				id: "template.build",
				title: template.state === "ready" || template.state === "stale" ? "Rebuild…" : "Build…",
				group: "Build",
				detail: stateLabel(template),
				icon: <WandIcon />,
				when: () => template.state !== "building",
				run: ({ pushPage }) => {
					pushPage(logPage(template.name));
					void buildTemplate(template.name);
				},
			},
			{
				id: "template.build.log",
				title: "Build log…",
				group: "Build",
				detail: template.lastBuild === undefined ? "No build yet" : "The last build's output",
				when: () => template.lastBuild !== undefined,
				run: ({ pushPage }) => pushPage(logPage(template.name)),
			},
			{
				id: "template.description",
				title: "Description…",
				group: "Recipe",
				detail: template.description ?? "No description",
				icon: <PencilIcon />,
				run: ({ prompt, replacePage }) =>
					prompt({
						title: "Description",
						initialValue: template.description ?? "",
						placeholder: "What this template is for",
						returnToPage: true,
						onSubmit: async (value) => {
							const description = value.trim();
							const state = await updateTemplate(
								template.name,
								recipeOf(template, { description }),
							);
							showTemplate(state, template.name, replacePage);
						},
					}),
			},
			{
				id: "template.base",
				title: "Base…",
				group: "Recipe",
				detail: sourceLabel(template),
				icon: <LayersIcon />,
				run: ({ pushPage }) => pushPage(basePage(template)),
			},
			{
				id: "template.commands",
				title: "Commands…",
				group: "Recipe",
				detail: `${template.run.length} command${template.run.length === 1 ? "" : "s"}`,
				icon: <WrenchIcon />,
				run: ({ pushPage }) => pushPage(commandsPage(template)),
			},
			...(template.error === undefined
				? []
				: [
						{
							id: "template.error",
							title: "The recipe cannot be read",
							group: "Recipe",
							detail: template.error,
							run: () => {},
						} satisfies Command,
					]),
			{
				id: "template.default",
				title: isDefault ? "Default template: on" : "Use as default",
				group: "Templates",
				detail: "New sandboxes start from it",
				icon: <CheckIcon />,
				current: isDefault,
				when: () => template.state === "ready" || template.state === "stale",
				keepOpen: true,
				run: async ({ replacePage }) => {
					replacePage(templatePage(template, true));
					await setSandboxSettings({ template: template.name });
				},
			},
			{
				id: "template.remove",
				title: "Remove from harness…",
				group: "Danger",
				detail: "Deletes the recipe and its build state; the E2B template stays",
				icon: <TrashIcon />,
				run: ({ pushPage }) =>
					pushPage(
						confirmPage(
							"Remove template",
							`Remove ${template.name}`,
							"The E2B template stays",
							() => void removeTemplate(template.name),
						),
					),
			},
			{
				id: "template.delete",
				title: "Delete in E2B…",
				group: "Danger",
				detail: "Deletes the E2B template and the recipe; running sandboxes keep running",
				icon: <TrashIcon />,
				when: () => template.lastBuild?.templateId !== undefined,
				run: ({ pushPage }) =>
					pushPage(
						confirmPage(
							"Delete template",
							`Delete ${template.name} in E2B`,
							"Cannot be undone",
							() => void deleteTemplate(template.name),
						),
					),
			},
			{
				id: "template.done",
				title: "Back to templates",
				group: "Templates",
				icon: <CheckIcon />,
				run: ({ replacePage }) => replacePage(page()),
			},
		],
	});

	const newTemplatePage = (name: string): CommandPage => {
		/** A loading page that creates the template, then shows its page. */
		const creatingPage = (recipe: TemplateRecipeInput): CommandPage => ({
			kind: "loading",
			title: `New template: ${name}`,
			load: async () => {
				const state = await createTemplate(name, recipe);
				const fresh = state?.templates.find((template) => template.name === name);
				return fresh !== undefined
					? templatePage(fresh)
					: page(
							state?.templates ?? templates,
							state?.configured ?? templatesConfigured,
							state?.providerName ?? templatesProviderName,
						);
			},
		});
		return {
			kind: "commands",
			title: `New template: ${name}`,
			placeholder: "Choose the starting point…",
			commands: [
				{
					id: "template.new.default",
					title: "E2B base image",
					group: "Base",
					detail: "Start from e2bdev/base",
					icon: <TerminalIcon />,
					run: ({ pushPage }) => pushPage(creatingPage({ source: { kind: "default" } })),
				},
				...templates.map((candidate): Command => ({
					id: `template.new.${candidate.name}`,
					title: candidate.name,
					group: "Sandbox templates",
					detail: stateLabel(candidate),
					icon: <LayersIcon />,
					run: ({ pushPage }) =>
						pushPage(creatingPage({ source: { kind: "template", name: candidate.name } })),
				})),
				{
					id: "template.new.image",
					title: "A Docker image…",
					group: "Base",
					detail: "e.g. node:22",
					icon: <FolderIcon />,
					run: ({ prompt, pushPage }) =>
						prompt({
							title: "Docker image",
							placeholder: "node:22",
							returnToPage: true,
							onSubmit: async (value) => {
								const image = value.trim();
								if (image === "") return false;
								const state = await createTemplate(name, { source: { kind: "image", image } });
								const fresh = state?.templates.find((template) => template.name === name);
								if (fresh !== undefined) pushPage(templatePage(fresh));
							},
						}),
				},
				{
					id: "template.new.blank",
					title: "Empty recipe",
					group: "Base",
					detail: "Write the recipe yourself later",
					run: ({ pushPage }) => pushPage(creatingPage({})),
				},
			],
		};
	};

	const page = (
		list: TemplateInfo[] = templates,
		configured: boolean = templatesConfigured,
		providerName: string = templatesProviderName,
	): CommandPage => {
		const hasStarter = list.some((template) => template.name === "harness-base");
		return {
			kind: "commands",
			title: "Sandbox templates",
			placeholder: "Search templates…",
			commands: [
				...list.map((template): Command => ({
					id: `template.manage.${template.name}`,
					title: template.name,
					group: "Templates",
					detail: `${templatesDefault === template.name ? "default · " : ""}${stateLabel(template)}${template.description === undefined ? "" : ` · ${template.description}`}`,
					icon: <TerminalIcon />,
					current: templatesDefault === template.name,
					run: ({ pushPage }) => pushPage(templatePage(template)),
				})),
				...templatesOther.map((template): Command => {
					const name = templateShortName(template.names[0] ?? template.templateId);
					return {
						id: `template.other.${template.templateId}`,
						title: name,
						group: "Other E2B templates",
						detail:
							template.buildStatus === undefined ? "in this E2B project" : template.buildStatus,
						run: ({ pushPage }) => pushPage(otherTemplatePage(template)),
					};
				}),
				{
					id: "template.new",
					title: "New template…",
					group: "Templates",
					detail: "Name a recipe, then choose its base",
					icon: <FilePlusIcon />,
					run: ({ prompt, pushPage }) =>
						prompt({
							title: "Template name",
							placeholder: "node-22",
							onSubmit: (value) => {
								const name = value.trim();
								if (name === "") return false;
								pushPage(newTemplatePage(name));
							},
						}),
				},
				...(hasStarter
					? []
					: [
							{
								id: "template.starter",
								title: "Create the starter template (harness-base)…",
								group: "Templates",
								detail: "E2B base plus build tools and websocat",
								icon: <WandIcon />,
								keepOpen: true,
								run: async ({ replacePage }) => {
									const state = await createStarterTemplate();
									if (state !== undefined)
										replacePage(page(state.templates, state.configured, state.providerName));
								},
							} satisfies Command,
						]),
				{
					id: "template.refresh",
					title: "Refresh templates",
					group: "Settings",
					detail: configured ? providerName : "Configure a sandbox provider first",
					icon: <RefreshIcon />,
					keepOpen: true,
					run: async ({ replacePage }) => {
						const state = await refreshTemplates();
						if (state !== undefined)
							replacePage(page(state.templates, state.configured, state.providerName));
					},
				},
			],
		};
	};

	return { page, open: () => openPage(page()) };
}
