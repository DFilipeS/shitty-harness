import type { Usage } from "@earendil-works/pi-ai";
import type { EntryRecord, UsageState } from "@harness/protocol";
import { assistantMessageOf } from "./messages.ts";

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
	const totals: UsageTotals = {
		tokens: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		cost: 0,
	};
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

/**
 * Tokens the next request will roughly carry: the last turn's input plus its output. While a turn
 * streams, its usage is the freshest estimate; once it is committed the entry wins, because some
 * providers only report usage on the final chunk and the live copy can still read zero.
 */
export function contextTokens(
	session:
		{ live?: { usage?: Usage; entryId?: unknown }; entries: readonly EntryRecord[] } | undefined,
): number | undefined {
	if (session === undefined) return undefined;
	const live = session.live;
	if (live?.entryId === undefined && live?.usage !== undefined && live.usage.totalTokens > 0) {
		return live.usage.totalTokens;
	}
	for (let index = session.entries.length - 1; index >= 0; index -= 1) {
		const entry = session.entries[index];
		if (entry === undefined) continue;
		const message = assistantMessageOf(entry);
		if (message !== undefined) return message.usage.totalTokens;
	}
	return undefined;
}
