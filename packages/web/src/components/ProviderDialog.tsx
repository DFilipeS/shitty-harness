import { useState } from "react";
import type { ProviderInfo } from "@harness/protocol";
import { useHarness } from "../lib/store.tsx";
import { RefreshIcon, XIcon } from "./icons.tsx";

export function ProviderDialog() {
	const { providerDialogOpen, closeProviderDialog, providers, refreshProviders } = useHarness();
	const [query, setQuery] = useState("");

	if (!providerDialogOpen) return null;

	const needle = query.trim().toLowerCase();
	const filtered = providers
		.filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(needle))
		.sort(
			(a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name),
		);

	return (
		<div
			className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
			onClick={closeProviderDialog}
		>
			<div
				className="flex h-full w-full flex-col bg-panel sm:h-auto sm:max-h-[85vh] sm:max-w-xl sm:rounded-xl sm:border sm:border-line sm:shadow-2xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="flex items-start justify-between border-b border-line px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 sm:pt-3">
					<div>
						<h2 className="text-sm font-semibold">Model providers</h2>
						<p className="mt-0.5 text-[11px] text-fg-subtle">
							API keys are stored in <code className="text-fg-muted">data/config.json</code> on the server.
						</p>
					</div>
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={() => void refreshProviders()}
							title="Refresh model lists"
							className="rounded-md p-1.5 text-fg-muted hover:bg-raised hover:text-fg"
						>
							<RefreshIcon />
						</button>
						<button
							type="button"
							onClick={closeProviderDialog}
							title="Close"
							className="rounded-md p-1.5 text-fg-muted hover:bg-raised hover:text-fg"
						>
							<XIcon />
						</button>
					</div>
				</div>

				<div className="border-b border-line px-4 py-2">
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search providers…"
						className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-base outline-none placeholder:text-fg-faint focus:border-line-strong sm:text-sm"
					/>
				</div>

				<div className="flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)] sm:pb-0">
					{filtered.map((provider) => (
						<ProviderRow key={provider.id} provider={provider} />
					))}
					{filtered.length === 0 && (
						<p className="px-4 py-8 text-center text-xs text-fg-subtle">No provider matches “{query}”.</p>
					)}
				</div>
			</div>
		</div>
	);
}

function ProviderRow({ provider }: { provider: ProviderInfo }) {
	const { configureProvider } = useHarness();
	const [editing, setEditing] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [saving, setSaving] = useState(false);

	const save = async () => {
		setSaving(true);
		const trimmed = apiKey.trim();
		await configureProvider(provider.id, trimmed === "" ? null : trimmed);
		setSaving(false);
		setEditing(false);
		setApiKey("");
	};

	return (
		<div className="border-b border-line/60 px-4 py-2.5">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="truncate text-sm">{provider.name}</span>
						{provider.configured && (
							<span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
								configured
							</span>
						)}
					</div>
					<div className="text-[11px] text-fg-subtle">
						{provider.id} · {provider.modelCount} models
						{provider.authSource === undefined ? "" : ` · ${provider.authSource}`}
					</div>
				</div>
				<button
					type="button"
					onClick={() => setEditing((value) => !value)}
					className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-fg-soft hover:border-fg-subtle pointer-coarse:py-2"
				>
					{editing ? "Cancel" : provider.configured ? "Edit" : "Connect"}
				</button>
			</div>
			{editing && (
				<div className="mt-2 flex items-center gap-2">
					<input
						autoFocus
						type="password"
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void save();
						}}
						placeholder={provider.configured ? "New API key (empty removes it)" : "API key"}
						className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-base outline-none placeholder:text-fg-faint focus:border-fg-subtle sm:text-sm"
					/>
					<button
						type="button"
						onClick={() => void save()}
						disabled={saving}
						className="rounded-md bg-fg px-3 py-1.5 text-xs font-medium text-canvas hover:bg-fg/90 disabled:opacity-40 pointer-coarse:py-2"
					>
						{saving ? "Saving…" : "Save"}
					</button>
				</div>
			)}
		</div>
	);
}
