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
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
			onClick={closeProviderDialog}
		>
			<div
				className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="flex items-start justify-between border-b border-zinc-800 px-4 py-3">
					<div>
						<h2 className="text-sm font-semibold">Model providers</h2>
						<p className="mt-0.5 text-[11px] text-zinc-500">
							API keys are stored in <code className="text-zinc-400">data/config.json</code> on the server.
						</p>
					</div>
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={() => void refreshProviders()}
							title="Refresh model lists"
							className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
						>
							<RefreshIcon />
						</button>
						<button
							type="button"
							onClick={closeProviderDialog}
							title="Close"
							className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
						>
							<XIcon />
						</button>
					</div>
				</div>

				<div className="border-b border-zinc-800 px-4 py-2">
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search providers…"
						className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
					/>
				</div>

				<div className="flex-1 overflow-y-auto">
					{filtered.map((provider) => (
						<ProviderRow key={provider.id} provider={provider} />
					))}
					{filtered.length === 0 && (
						<p className="px-4 py-8 text-center text-xs text-zinc-500">No provider matches “{query}”.</p>
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
		<div className="border-b border-zinc-800/60 px-4 py-2.5">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="truncate text-sm">{provider.name}</span>
						{provider.configured && (
							<span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">
								configured
							</span>
						)}
					</div>
					<div className="text-[11px] text-zinc-500">
						{provider.id} · {provider.modelCount} models
						{provider.authSource === undefined ? "" : ` · ${provider.authSource}`}
					</div>
				</div>
				<button
					type="button"
					onClick={() => setEditing((value) => !value)}
					className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500"
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
						className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-500"
					/>
					<button
						type="button"
						onClick={() => void save()}
						disabled={saving}
						className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-40"
					>
						{saving ? "Saving…" : "Save"}
					</button>
				</div>
			)}
		</div>
	);
}
