import type { UsageState } from "@harness/protocol";

export type UsageTotals = {
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number;
};

/** Sums every model and tool bucket of a session's usage. Undefined until something is recorded. */
export function usageTotals(usage: UsageState | undefined): UsageTotals | undefined {
	if (usage === undefined) return undefined;
	const totals: UsageTotals = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
	let recorded = false;
	// The buckets are required by the type, but be forgiving about partial state.
	for (const bucket of [usage.models ?? {}, usage.tools ?? {}]) {
		for (const entry of Object.values(bucket)) {
			recorded = true;
			totals.tokens += entry.totalTokens;
			totals.input += entry.input;
			totals.output += entry.output;
			totals.cacheRead += entry.cacheRead;
			totals.cacheWrite += entry.cacheWrite;
			totals.reasoning += entry.reasoning ?? 0;
			totals.cost += entry.cost.total;
		}
	}
	return recorded ? totals : undefined;
}

/** Share of prompt tokens served from cache, or undefined when the provider reports no caching. */
export function cacheHitRate(totals: UsageTotals): number | undefined {
	const cached = totals.cacheRead + totals.cacheWrite;
	const cacheable = totals.input + cached;
	if (cached === 0 || cacheable === 0) return undefined;
	return totals.cacheRead / cacheable;
}
