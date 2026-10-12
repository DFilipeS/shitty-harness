import { useHarness } from "../lib/store.tsx";
import { XIcon } from "./icons.tsx";

export function ErrorToast() {
	const { error, clearError } = useHarness();
	if (error === undefined) return null;
	return (
		<div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
			<div className="flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-950/90 px-4 py-2 text-sm text-red-200 shadow-lg">
				<span>{error}</span>
				<button type="button" onClick={clearError} className="text-red-300 hover:text-red-100" title="Dismiss">
					<XIcon className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}
