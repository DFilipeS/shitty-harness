import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
	collectCommands,
	formatKeys,
	type Command,
	type CommandContext,
	type CommandPage,
	type CommandRegistry,
	type PaletteStart,
	type PromptOptions,
} from "../lib/commands.tsx";
import { SHORTCUTS } from "../lib/shortcuts.ts";
import { ArrowLeftIcon, CheckIcon, SearchIcon } from "./icons.tsx";

const HELP: { keys: string; label: string }[] = [
	{ keys: SHORTCUTS.palette, label: "Open the command palette" },
	{ keys: SHORTCUTS.sidebar, label: "Toggle the sessions sidebar" },
	{ keys: SHORTCUTS.help, label: "Show the shortcut list" },
	{ keys: "enter", label: "Send the message" },
	{ keys: "shift+enter", label: "New line in the message" },
	{ keys: "up+down", label: "Move through the palette list" },
	{ keys: "escape", label: "Close the palette or a dialog" },
];

type State = {
	pages: CommandPage[];
	query: string;
	selected: number;
	prompt?: PromptOptions;
	promptValue: string;
};

const EMPTY: State = { pages: [], query: "", selected: 0, promptValue: "" };

/** Ranks a command against the query. Lower is better; undefined means no match. */
function score(command: Command, query: string): number | undefined {
	const needles = [command.title, ...(command.keywords ?? [])].map((value) => value.toLowerCase());
	let total = 0;
	for (const token of query.split(/\s+/).filter(Boolean)) {
		let best: number | undefined;
		for (const needle of needles) {
			if (needle === token) best = Math.min(best ?? 0, 0);
			else if (needle.startsWith(token)) best = Math.min(best ?? 1, 1);
			else if (needle.split(/[^a-z0-9]+/).some((word) => word.startsWith(token))) best = Math.min(best ?? 2, 2);
			else if (needle.includes(token)) best = Math.min(best ?? 3, 3);
		}
		if (best === undefined) return undefined;
		total += best;
	}
	return total;
}

function filter(commands: Command[], query: string): Command[] {
	const available = commands.filter((command) => command.when?.() !== false);
	const needle = query.trim().toLowerCase();
	if (needle === "") return available;
	return available
		.map((command) => ({ command, rank: score(command, needle) }))
		.filter((entry): entry is { command: Command; rank: number } => entry.rank !== undefined)
		.sort((a, b) => a.rank - b.rank)
		.map((entry) => entry.command);
}

type Group = { name: string; items: { command: Command; index: number }[] };

/**
 * Groups rows under their heading. The filter ranks rows by match score, which can scatter a
 * group's rows through the list, so the flat index is assigned in rendered order (group by group)
 * rather than ranked order. Arrowing then moves down the list the user sees.
 */
function groupCommands(commands: Command[]): { groups: Group[]; rows: Command[] } {
	const byGroup = new Map<string, Command[]>();
	for (const command of commands) {
		const existing = byGroup.get(command.group);
		if (existing === undefined) byGroup.set(command.group, [command]);
		else existing.push(command);
	}
	const groups: Group[] = [];
	const rows: Command[] = [];
	for (const [name, commandsInGroup] of byGroup) {
		const items: { command: Command; index: number }[] = [];
		for (const command of commandsInGroup) {
			items.push({ command, index: rows.length });
			rows.push(command);
		}
		groups.push({ name, items });
	}
	return { groups, rows };
}

export function CommandPalette({
	open,
	initial,
	registry,
	onClose,
}: {
	open: boolean;
	initial: PaletteStart;
	registry: CommandRegistry;
	onClose: () => void;
}) {
	const [state, setState] = useState<State>(EMPTY);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	// Snapshot the registered commands and reset the search each time the palette opens.
	useLayoutEffect(() => {
		if (!open) return;
		setState({
			pages: [
				initial.kind === "shortcuts"
					? { kind: "shortcuts", title: "Keyboard shortcuts" }
					: initial.kind === "page"
						? initial.page
						: { kind: "commands", title: "Commands", commands: collectCommands(registry) },
			],
			query: "",
			selected: 0,
			...(initial.kind === "prompt"
				? { prompt: initial.options, promptValue: initial.options.initialValue ?? "" }
				: { promptValue: "" }),
		});
		inputRef.current?.focus();
	}, [open, initial, registry]);

	// A prompt replaces the list, so select its initial value for quick editing.
	useLayoutEffect(() => {
		if (!open || state.prompt === undefined) return;
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [open, state.prompt]);

	const page = state.pages[state.pages.length - 1];
	const matches = state.prompt === undefined && page?.kind === "commands" ? filter(page.commands, state.query) : [];
	const { groups, rows } = groupCommands(matches);
	const shortcuts =
		state.prompt === undefined && page?.kind === "shortcuts"
			? HELP.filter((shortcut) => shortcut.label.toLowerCase().includes(state.query.trim().toLowerCase()))
			: [];
	const selected = rows.length === 0 ? -1 : Math.min(state.selected, rows.length - 1);
	// Only the plain command list shows a count; a page opened directly shows its own title.
	const rootCommands = state.pages.length === 1 && initial.kind === "commands";

	// Keep the selected row in view while arrowing through a long list.
	useLayoutEffect(() => {
		if (selected < 0) return;
		listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
	}, [selected, rows.length]);

	const move = (delta: number) => {
		if (rows.length === 0) return;
		setState((current) => ({
			...current,
			selected: (Math.min(current.selected, rows.length - 1) + delta + rows.length) % rows.length,
		}));
	};

	const runCommand = (command: Command) => {
		let navigated = false;
		const context: CommandContext = {
			pushPage: (next) => {
				navigated = true;
				setState((current) => ({
					...current,
					pages: [...current.pages, next],
					query: "",
					selected: 0,
					prompt: undefined,
					promptValue: "",
				}));
			},
			prompt: (options) => {
				navigated = true;
				setState((current) => ({
					...current,
					prompt: options,
					promptValue: options.initialValue ?? "",
					selected: 0,
				}));
			},
			close: onClose,
		};
		void command.run(context);
		if (!navigated) onClose();
	};

	const goBack = () => {
		if (state.prompt !== undefined) {
			setState((current) => ({ ...current, prompt: undefined, promptValue: "", selected: 0 }));
			return;
		}
		if (state.pages.length > 1) {
			setState((current) => ({ ...current, pages: current.pages.slice(0, -1), query: "", selected: 0 }));
			return;
		}
		onClose();
	};

	const submitPrompt = () => {
		const prompt = state.prompt;
		if (prompt === undefined) return;
		const result = prompt.onSubmit(state.promptValue);
		if (result === false) return;
		onClose();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
			event.preventDefault();
			move(1);
		} else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
			event.preventDefault();
			move(-1);
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (state.prompt !== undefined) submitPrompt();
			else if (selected >= 0 && rows[selected] !== undefined) runCommand(rows[selected]);
		} else if (event.key === "Escape") {
			event.preventDefault();
			goBack();
		} else if (event.key === "Backspace" && state.query === "" && state.prompt === undefined && state.pages.length > 1) {
			event.preventDefault();
			goBack();
		}
	};

	if (!open) return null;

	const nested = state.prompt !== undefined || state.pages.length > 1;

	return (
		<div
			className="fixed inset-0 z-[60] flex items-start justify-center px-3 pt-[12vh] sm:pt-[15vh]"
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
		>
			<div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
			<div className="relative flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
				<div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
					{nested ? (
						<button
							type="button"
							onClick={goBack}
							title="Back"
							className="-ml-1 shrink-0 rounded p-1 text-fg-subtle hover:bg-raised hover:text-fg"
						>
							<ArrowLeftIcon />
						</button>
					) : (
						<SearchIcon className="h-4 w-4 shrink-0 text-fg-subtle" />
					)}
					<input
						ref={inputRef}
						value={state.prompt === undefined ? state.query : state.promptValue}
						onChange={(event) => {
							const value = event.target.value;
							setState((current) =>
								current.prompt === undefined
									? { ...current, query: value, selected: 0 }
									: { ...current, promptValue: value },
							);
						}}
						onKeyDown={onKeyDown}
						placeholder={
							state.prompt?.placeholder ??
							(page?.kind === "commands" ? (page.placeholder ?? "Type a command…") : "Keyboard shortcuts")
						}
						type={state.prompt?.secret === true ? "password" : "text"}
						autoComplete="off"
						spellCheck={false}
						role="combobox"
						aria-expanded="true"
						aria-controls="command-palette-list"
						aria-activedescendant={selected >= 0 ? `command-${rows[selected]?.id ?? ""}` : undefined}
						className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-fg-faint sm:text-sm"
					/>
				</div>

				{state.prompt !== undefined && (
					<p className="border-b border-line px-4 py-2 text-xs text-fg-subtle">{state.prompt.title}</p>
				)}

				{state.prompt === undefined && (
					<div
						ref={listRef}
						id="command-palette-list"
						role="listbox"
						onMouseDown={(event) => event.preventDefault()}
						className="flex-1 overflow-y-auto overscroll-contain p-1.5"
					>
					{page?.kind === "shortcuts" &&
						(shortcuts.length === 0 ? (
							<p className="px-3 py-8 text-center text-xs text-fg-subtle">No shortcut matches “{state.query}”.</p>
						) : (
							<ul className="py-1">
								{shortcuts.map((shortcut) => (
									<li key={shortcut.keys} className="flex items-center justify-between gap-3 px-3 py-1.5">
										<span className="text-sm text-fg-soft">{shortcut.label}</span>
										<kbd className="shrink-0 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-fg-subtle">
											{formatKeys(shortcut.keys)}
										</kbd>
									</li>
								))}
							</ul>
						))}

					{state.prompt === undefined &&
						page?.kind === "commands" &&
						groups.map((group) => (
							<div key={group.name}>
								<div className="px-2.5 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-fg-faint uppercase">
									{group.name}
								</div>
								{group.items.map(({ command, index }) => (
									<button
										key={command.id}
										id={`command-${command.id}`}
										data-index={index}
										type="button"
										role="option"
										aria-selected={index === selected}
										onMouseMove={() =>
											setState((current) => (current.selected === index ? current : { ...current, selected: index }))
										}
										onClick={() => runCommand(command)}
										className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ${
											index === selected ? "bg-raised" : ""
										}`}
									>
										{command.icon !== undefined && <span className="shrink-0 text-fg-subtle">{command.icon}</span>}
										<span className="min-w-0 flex-1 truncate text-sm">{command.title}</span>
										{command.badges !== undefined && (
											<span className="flex shrink-0 items-center gap-1.5 text-fg-muted">{command.badges}</span>
										)}
										{command.detail !== undefined && (
											<span className="max-w-[45%] shrink-0 truncate text-[11px] text-fg-faint">
												{command.detail}
											</span>
										)}
										{command.current === true && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-ok" />}
										{command.keys !== undefined && (
											<kbd className="shrink-0 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-fg-subtle">
												{formatKeys(command.keys)}
											</kbd>
										)}
									</button>
								))}
							</div>
						))}

						{page?.kind === "commands" && rows.length === 0 && (
							<p className="px-3 py-8 text-center text-xs text-fg-subtle">No commands match “{state.query}”.</p>
						)}
					</div>
				)}

				<div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-[11px] text-fg-faint">
					<span className="truncate">
						{state.prompt !== undefined
							? state.prompt.title
							: rootCommands
								? `${rows.length} command${rows.length === 1 ? "" : "s"}`
								: page?.title}
					</span>
					<span className="hidden shrink-0 sm:inline">
						{state.prompt !== undefined
							? "↵ save · esc cancel"
							: page?.kind === "shortcuts"
								? "esc close"
								: "↑↓ navigate · ↵ select · esc close"}
					</span>
				</div>
			</div>
		</div>
	);
}
