import type { ModelInfo } from "@harness/protocol";

/** What a model can do beyond plain text, in the order the picker shows it. */
export type ModelCapability = "reasoning" | "image";

export function modelCapabilities(model: ModelInfo): ModelCapability[] {
	const capabilities: ModelCapability[] = [];
	if (model.reasoning) capabilities.push("reasoning");
	if (model.input.includes("image")) capabilities.push("image");
	return capabilities;
}
