import { contextTone, formatCost, formatTokens } from "../lib/format.ts";
import { useHarness } from "../lib/store.tsx";
import { cacheHitRate, contextTokens, usageTotals } from "../lib/usage.ts";
import { ProgressRing } from "./ProgressRing.tsx";

/** Session spend, tokens, context use, and cache stats for the chat header. */
export function SessionStats() {
	const { activeSession, models } = useHarness();
	const totals = usageTotals(activeSession?.usage);
	if (totals === undefined) return null;

	// Providers only report cache tokens once a call reuses a cached prefix, so the rate reads
	// 0% until the conversation is long enough (or a provider does not cache at all).
	const rate = cacheHitRate(totals);
	const percent = Math.round((rate ?? 0) * 100);
	const cached = totals.cacheRead + totals.cacheWrite;
	const exactCost = totals.cost > 0 && totals.cost < 0.01 ? `$${totals.cost.toFixed(6)}` : formatCost(totals.cost);

	const model = activeSession?.agent.model;
	const info = models.find((candidate) => candidate.provider === model?.provider && candidate.id === model.modelId);
	const used = contextTokens(activeSession);
	const context =
		info !== undefined && info.contextWindow > 0 && used !== undefined
			? { used, window: info.contextWindow, percent: Math.round((used / info.contextWindow) * 100) }
			: undefined;
	const contextClass = context === undefined ? "" : contextTone(context.percent);

	const details = [
		`${totals.tokens.toLocaleString()} tokens (${totals.input.toLocaleString()} in, ${totals.output.toLocaleString()} out)`,
		context === undefined
			? undefined
			: `Context: ${context.used.toLocaleString()} / ${context.window.toLocaleString()} tokens (${context.percent}%)`,
		cached === 0
			? "Cache: no cache hits yet"
			: `Cache: ${totals.cacheRead.toLocaleString()} read, ${totals.cacheWrite.toLocaleString()} written (${percent}%)`,
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
			{context !== undefined && (
				<>
					<span className="hidden text-fg-faint sm:inline">·</span>
					<span className={`hidden items-center gap-1 sm:inline-flex ${contextClass}`}>
						<ProgressRing percent={context.percent} />
						{context.percent}% context
					</span>
				</>
			)}
			<span className="hidden text-fg-faint sm:inline">·</span>
			<span className={`hidden items-center gap-1 sm:inline-flex ${cached === 0 ? "" : "text-ok"}`}>
				<ProgressRing percent={percent} />
				{percent}% cache
			</span>
		</div>
	);
}
