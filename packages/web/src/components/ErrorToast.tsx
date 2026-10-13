import { useHarness } from "../lib/store.tsx";
import { XIcon } from "./icons.tsx";

export function ErrorToast() {
	const { error, clearError } = useHarness();
	if (error === undefined) return null;
	return (
		<div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
			<div className="flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-950/90 px-4 py-2 text-sm text-red-200 shadow-lg">
				<span className="min-w-0 flex-1 break-words">{error}</span>
				<button type="button" onClick={clearError} className="text-red-300 hover:text-red-100" title="Dismiss">
					<XIcon className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}
