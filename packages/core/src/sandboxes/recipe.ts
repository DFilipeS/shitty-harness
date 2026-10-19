import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SandboxError } from "./provider.ts";

/** E2B template names are lowercased and match `^[a-z0-9-_]+$`. */
const TEMPLATE_NAME_PATTERN = /^[a-z0-9-_]{1,128}$/;

/** Where a sandbox template build starts. */
export type TemplateSource =
	{ kind: "default" } | { kind: "template"; name: string } | { kind: "image"; image: string };

/** A template recipe: where the build starts and the commands it runs. */
export type TemplateRecipe = {
	description?: string;
	source: TemplateSource;
	run: string[];
};

/** A recipe as it arrives from a client, before normalization. */
export type TemplateRecipeInput = {
	description?: string;
	source?: TemplateSource;
	run?: string[];
};

/** Normalize a template name to its stored form, or `undefined` when it is not valid. */
export function templateName(value: string): string | undefined {
	const name = value.trim().toLowerCase();
	return TEMPLATE_NAME_PATTERN.test(name) ? name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): SandboxError {
	return new SandboxError("invalid", message);
}

/**
 * One command from a recipe list. YAML reads bare `true` or `42` as scalars, not strings, so those
 * become the command they spell; anything else is invalid.
 */
function commandOf(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

/** Parse and validate a recipe file. Throws a `SandboxError("invalid")` on bad input. */
export function parseRecipe(text: string): TemplateRecipe {
	let document: unknown;
	try {
		document = parseYaml(text);
	} catch (error) {
		throw invalid(
			`The recipe is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (document === null || document === undefined) return { source: { kind: "default" }, run: [] };
	if (!isRecord(document))
		throw invalid("The recipe must be a mapping with `description`, `from`, and `run`");
	for (const key of Object.keys(document)) {
		if (key !== "description" && key !== "from" && key !== "run") {
			throw invalid(`Unknown recipe field: ${key}`);
		}
	}
	const recipe: TemplateRecipe = { source: { kind: "default" }, run: [] };
	if (document.description !== undefined) {
		if (typeof document.description !== "string") throw invalid("`description` must be a string");
		const description = document.description.trim();
		if (description !== "") recipe.description = description;
	}
	if (document.from !== undefined) recipe.source = parseSource(document.from);
	if (document.run !== undefined) {
		if (!Array.isArray(document.run)) throw invalid("`run` must be a list of commands");
		for (const [index, value] of document.run.entries()) {
			const command = commandOf(value);
			if (command === undefined) throw invalid(`run[${index}] must be a non-empty command string`);
			recipe.run.push(command);
		}
	}
	return recipe;
}

function parseSource(value: unknown): TemplateSource {
	if (!isRecord(value)) throw invalid("`from` must be a mapping with `template` or `image`");
	for (const key of Object.keys(value)) {
		if (key !== "template" && key !== "image") throw invalid(`Unknown \`from\` field: ${key}`);
	}
	const template = value.template;
	const image = value.image;
	if (template !== undefined && image !== undefined) {
		throw invalid("`from` must have either `template` or `image`, not both");
	}
	if (template !== undefined) {
		if (typeof template !== "string" || template.trim() === "")
			throw invalid("`from.template` must be a template name");
		return { kind: "template", name: template.trim() };
	}
	if (image !== undefined) {
		if (typeof image !== "string" || image.trim() === "")
			throw invalid("`from.image` must be an image name");
		return { kind: "image", image: image.trim() };
	}
	return { kind: "default" };
}

/** Normalize a recipe that arrived from a client, applying the same rules as a parsed file. */
export function normalizeRecipe(input: TemplateRecipeInput): TemplateRecipe {
	const recipe: TemplateRecipe = { source: { kind: "default" }, run: [] };
	if (input.description !== undefined) {
		if (typeof input.description !== "string") throw invalid("`description` must be a string");
		const description = input.description.trim();
		if (description !== "") recipe.description = description;
	}
	if (input.source !== undefined) {
		const source = input.source;
		if (source.kind === "template") {
			if (typeof source.name !== "string" || source.name.trim() === "")
				throw invalid("`from.template` must be a template name");
			recipe.source = { kind: "template", name: source.name.trim() };
		} else if (source.kind === "image") {
			if (typeof source.image !== "string" || source.image.trim() === "")
				throw invalid("`from.image` must be an image name");
			recipe.source = { kind: "image", image: source.image.trim() };
		} else if (source.kind === "default") {
			recipe.source = { kind: "default" };
		} else {
			throw invalid("`from` must be a template, an image, or the provider default");
		}
	}
	if (input.run !== undefined) {
		if (!Array.isArray(input.run)) throw invalid("`run` must be a list of commands");
		for (const [index, value] of input.run.entries()) {
			const command = commandOf(value);
			if (command === undefined) throw invalid(`run[${index}] must be a non-empty command string`);
			recipe.run.push(command);
		}
	}
	return recipe;
}

/** Render a recipe as the YAML the harness stores. */
export function serializeRecipe(recipe: TemplateRecipe): string {
	const document: Record<string, unknown> = {};
	if (recipe.description !== undefined && recipe.description !== "")
		document.description = recipe.description;
	if (recipe.source.kind === "template") document.from = { template: recipe.source.name };
	else if (recipe.source.kind === "image") document.from = { image: recipe.source.image };
	document.run = [...recipe.run];
	return stringifyYaml(document, { lineWidth: 0 });
}

/** The starter template the Templates page offers: the E2B base plus common tools and websocat. */
export const STARTER_TEMPLATE_NAME = "harness-base";

export const STARTER_RECIPE: TemplateRecipe = {
	description: "E2B base plus common build tools, websocat, Docker, and mise",
	source: { kind: "default" },
	run: [
		"apt-get update && apt-get install -y git curl ca-certificates build-essential jq unzip procps",
		'ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) ASSET=websocat.aarch64-unknown-linux-musl ;; *) ASSET=websocat.x86_64-unknown-linux-musl ;; esac; curl -fsSL -o /usr/local/bin/websocat "https://github.com/vi/websocat/releases/latest/download/$ASSET"; chmod +x /usr/local/bin/websocat',
		"curl -fsSL https://get.docker.com | sh",
		"usermod -aG docker user",
		"docker --version && docker compose version",
		"curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh",
		"mise --version",
	],
};
