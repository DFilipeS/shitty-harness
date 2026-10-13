import { formatCost, formatTokens } from "../lib/format.ts";
import { useHarness } from "../lib/store.tsx";
import { cacheHitRate, usageTotals } from "../lib/usage.ts";

/** Session spend and token stats for the chat header. Hidden until the first model call. */
export function SessionStats() {
	const { activeSession } = useHarness();
	const totals = usageTotals(activeSession?.usage);
	if (totals === undefined) return null;

	// Providers only report cache tokens once a call reuses a cached prefix, so the rate reads
	// 0% until the conversation is long enough (or a provider does not cache at all).
	const rate = cacheHitRate(totals);
	const percent = Math.round((rate ?? 0) * 100);
	const cached = totals.cacheRead + totals.cacheWrite;
	const exactCost = totals.cost > 0 && totals.cost < 0.01 ? `$${totals.cost.toFixed(6)}` : formatCost(totals.cost);
	const details = [
		`${totals.tokens.toLocaleString()} tokens (${totals.input.toLocaleString()} in, ${totals.output.toLocaleString()} out)`,
		cached === 0
			? "Cache: no cache hits yet"
			: `Cache: ${totals.cacheRead.toLocaleString()} read, ${totals.cacheWrite.toLocaleString()} written (${percent}%)`,
		`Cost: ${exactCost}`,
	];

	return (
		<div
			data-session-stats
			className="flex shrink-0 items-center gap-1.5 text-[11px] text-fg-subtle tabular-nums"
			title={details.join("\n")}
		>
			<span>{formatCost(totals.cost)}</span>
			<span className="hidden text-fg-faint sm:inline">·</span>
			<span className="hidden sm:inline">{formatTokens(totals.tokens)} tokens</span>
			<span className="hidden text-fg-faint sm:inline">·</span>
			<span className="hidden sm:inline">{percent}% cache</span>
		</div>
	);
}
