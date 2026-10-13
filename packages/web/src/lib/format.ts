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
