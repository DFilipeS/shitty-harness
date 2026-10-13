import { formatCost, formatTokens } from "../lib/format.ts";
import { useHarness } from "../lib/store.tsx";
import { cacheHitRate, usageTotals } from "../lib/usage.ts";

/** Session spend and token stats for the chat header. Hidden until the first model call. */
export function SessionStats() {
	const { activeSession } = useHarness();
	const totals = usageTotals(activeSession?.usage);
	if (totals === undefined) return null;

	const rate = cacheHitRate(totals);
	const exactCost = totals.cost > 0 && totals.cost < 0.01 ? `$${totals.cost.toFixed(6)}` : formatCost(totals.cost);
	const details = [
		`${totals.tokens.toLocaleString()} tokens (${totals.input.toLocaleString()} in, ${totals.output.toLocaleString()} out)`,
		rate === undefined
			? undefined
			: `Cache: ${totals.cacheRead.toLocaleString()} read, ${totals.cacheWrite.toLocaleString()} written (${Math.round(rate * 100)}%)`,
		`Cost: ${exactCost}`,
	].filter((line): line is string => line !== undefined);

	return (
		<div
			data-session-stats
			className="flex shrink-0 items-center gap-1.5 text-[11px] text-fg-subtle tabular-nums"
			title={details.join("\n")}
		>
			<span>{formatCost(totals.cost)}</span>
			<span className="hidden text-fg-faint sm:inline">·</span>
			<span className="hidden sm:inline">{formatTokens(totals.tokens)} tokens</span>
			{rate !== undefined && (
				<>
					<span className="hidden text-fg-faint md:inline">·</span>
					<span className="hidden md:inline">{Math.round(rate * 100)}% cache</span>
				</>
			)}
		</div>
	);
}
