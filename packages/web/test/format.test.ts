import type { ProviderRefreshReport } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import { formatRefreshNotice } from "../src/lib/format.ts";

function report(overrides: Partial<ProviderRefreshReport>): ProviderRefreshReport {
	return {
		providerId: "openrouter",
		name: "OpenRouter",
		outcome: "fetched",
		models: 10,
		added: 0,
		...overrides,
	};
}

describe("formatRefreshNotice", () => {
	it("has nothing to say without reports", () => {
		expect(formatRefreshNotice([])).toBeUndefined();
	});

	it("names the new models", () => {
		expect(formatRefreshNotice([report({ added: 1 })])).toEqual({
			tone: "info",
			text: "OpenRouter: 1 new model (10 total)",
		});
		expect(formatRefreshNotice([report({ added: 3 })])?.text).toBe(
			"OpenRouter: 3 new models (10 total)",
		);
	});

	it("names the removed models", () => {
		expect(formatRefreshNotice([report({ added: -2 })])).toEqual({
			tone: "info",
			text: "OpenRouter: 2 models removed (10 total)",
		});
	});

	it("says up to date when nothing changed", () => {
		expect(formatRefreshNotice([report({ added: 0 })])).toEqual({
			tone: "info",
			text: "OpenRouter: up to date",
		});
		expect(formatRefreshNotice([report({ outcome: "throttled" })])?.text).toBe(
			"OpenRouter: checked recently",
		);
		expect(formatRefreshNotice([report({ outcome: "unavailable" })])?.text).toBe(
			"OpenRouter: no remote catalog",
		);
	});

	it("reports failures in an error tone", () => {
		const notice = formatRefreshNotice([report({ outcome: "failed", error: "HTTP 500" })]);
		expect(notice).toEqual({ tone: "error", text: "OpenRouter: refresh failed (HTTP 500)" });
	});
});
