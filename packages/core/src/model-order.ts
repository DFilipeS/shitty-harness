const MODEL_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Sorts models alphabetically by display name within each provider, keeping the provider order
 * from the catalog. The model picker groups by provider, so this is the order users see; callers
 * that pick a fallback model (e.g. "first available") use it too, so the first row is the one
 * a new session gets.
 */
export function sortModelsForDisplay<T extends { provider: string; name: string }>(
	models: readonly T[],
): T[] {
	const groups = new Map<string, T[]>();
	for (const model of models) {
		const group = groups.get(model.provider);
		if (group === undefined) groups.set(model.provider, [model]);
		else group.push(model);
	}
	return [...groups.values()].flatMap((group) =>
		group.sort((a, b) => MODEL_NAME_COLLATOR.compare(a.name, b.name)),
	);
}
