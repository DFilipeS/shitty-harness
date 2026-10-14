import { useEffect } from "react";
import { useHarness } from "../lib/store.tsx";
import { XIcon } from "./icons.tsx";

const NOTICE_TIMEOUT_MS = 6_000;

/**
 * Bottom-center toast. Command errors stay until dismissed; refresh notices fade on their own.
 */
export function Toast() {
	const { error, clearError, notice, clearNotice } = useHarness();

	useEffect(() => {
		if (notice === undefined) return;
		const timer = setTimeout(clearNotice, NOTICE_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [notice, clearNotice]);

	const message = error ?? notice?.text;
	if (message === undefined) return null;
	const isError = error !== undefined || notice?.tone === "error";

	return (
		<div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
			<div
				data-toast={isError ? "error" : "info"}
				className={
					isError
						? "flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-600/95 px-4 py-2 text-sm text-white shadow-lg dark:bg-red-950/90 dark:text-red-200"
						: "flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2 text-sm text-fg shadow-lg"
				}
			>
				<span className="min-w-0 flex-1 break-words">{message}</span>
				<button
					type="button"
					onClick={error !== undefined ? clearError : clearNotice}
					className={
						isError
							? "text-white/80 hover:text-white dark:text-red-300 dark:hover:text-red-100"
							: "text-fg-subtle hover:text-fg"
					}
					title="Dismiss"
				>
					<XIcon className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}
