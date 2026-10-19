import { describe, expect, it } from "vitest";
import { guidanceRules } from "../src/agent-guidance.ts";

const offered = (names: readonly string[]) => (name: string) => names.includes(name);

describe("guidanceRules", () => {
	it("names every tool when everything is offered", () => {
		const rules = guidanceRules(offered(["bash", "codemode", "ask_user"]), "TARGET").join("\n");
		expect(rules).toContain("bash");
		expect(rules).toContain("codemode");
		expect(rules).toContain("ask_user");
		expect(rules).toContain("TARGET");
	});

	it("never names a tool the request does not offer", () => {
		const rules = guidanceRules(offered([]), "TARGET").join("\n");
		expect(rules).toContain("TARGET");
		expect(rules).not.toContain("bash");
		expect(rules).not.toContain("codemode");
		expect(rules).not.toContain("ask_user");
	});

	it("keeps the generic rules whatever is offered", () => {
		const rules = guidanceRules(offered([]), "TARGET");
		expect(rules.length).toBeGreaterThan(1);
	});
});
