import type { ProviderRefreshReport } from "@harness/protocol";

export function relativeTime(timestamp: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(timestamp).toLocaleDateString();
}

/** `$0.0123` for small amounts, `$1.23` for larger ones, `<$0.0001` for dust. */
export function formatCost(value: number): string {
	if (value === 0) return "$0.00";
	if (value < 0.00005) return "<$0.0001";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 1) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

/** Text color for a context share: amber near the limit, red past it, default otherwise. */
export function contextTone(percent: number): string {
	if (percent >= 95) return "text-red-500";
	if (percent >= 80) return "text-warn";
	return "";
}

/** Compact token counts: `845`, `1.2k`, `12k`, `1.2M`. */
export function formatTokens(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** One line per provider describing what a model catalog refresh did, e.g. "OpenRouter: 3 new models". */
export function formatRefreshNotice(
	reports: readonly ProviderRefreshReport[],
): { text: string; tone: "info" | "error" } | undefined {
	if (reports.length === 0) return undefined;
	const failed = reports.filter((report) => report.outcome === "failed");
	if (failed.length > 0) {
		return {
			tone: "error",
			text: failed
				.map((report) => `${report.name}: refresh failed${report.error === undefined ? "" : ` (${report.error})`}`)
				.join(" · "),
		};
	}
	const parts = reports.map((report) => {
		if (report.outcome === "fetched" && report.added > 0) {
			return `${report.name}: ${report.added} new model${report.added === 1 ? "" : "s"} (${report.models} total)`;
		}
		if (report.outcome === "unavailable") return `${report.name}: no remote catalog`;
		if (report.outcome === "throttled") return `${report.name}: checked recently`;
		return `${report.name}: up to date`;
	});
	return { tone: "info", text: parts.join(" · ") };
}
