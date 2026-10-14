import { describe, expect, it } from "vitest";
import { sortModelsForDisplay } from "../src/model-order.ts";

const model = (provider: string, name: string) => ({ provider, name });

describe("sortModelsForDisplay", () => {
	it("sorts by name inside each provider and keeps the provider order", () => {
		const sorted = sortModelsForDisplay([
			model("openrouter", "Google: Gemini 3"),
			model("fireworks", "Zeta"),
			model("openrouter", "Anthropic: Claude 5"),
			model("fireworks", "Alpha"),
		]);
		expect(sorted.map((entry) => `${entry.provider}/${entry.name}`)).toEqual([
			"openrouter/Anthropic: Claude 5",
			"openrouter/Google: Gemini 3",
			"fireworks/Alpha",
			"fireworks/Zeta",
		]);
	});

	it("compares numbers as numbers", () => {
		const sorted = sortModelsForDisplay([
			model("p", "GPT-5.10"),
			model("p", "GPT-5.9"),
			model("p", "GPT-5"),
		]);
		expect(sorted.map((entry) => entry.name)).toEqual(["GPT-5", "GPT-5.9", "GPT-5.10"]);
	});

	it("keeps the catalog order for equal names", () => {
		const first = { provider: "p", name: "Same", id: 1 };
		const second = { provider: "p", name: "Same", id: 2 };
		expect(sortModelsForDisplay([first, second]).map((entry) => entry.id)).toEqual([1, 2]);
	});
});
