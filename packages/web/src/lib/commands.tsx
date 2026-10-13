import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CommandPalette } from "../components/CommandPalette.tsx";

/**
 * A single action offered by the palette. Commands are registered by the component that owns
 * the feature, so the chat page can expose session commands while the shell exposes global ones.
 */
export type Command = {
	id: string;
	title: string;
	/** The heading this command sits under in the palette. */
	group: string;
	/** Extra words that match the search, e.g. synonyms. */
	keywords?: string[];
	/** Small text shown at the right of the row. */
	detail?: string;
	/** Display-only shortcut hint, e.g. "⌘B". */
	shortcut?: string;
	icon?: ReactNode;
	/** Hides the command while this returns false. */
	when?: () => boolean;
	/** Marks the row as the current choice, e.g. the active model. */
	current?: boolean;
	/**
	 * Runs the command. Navigation (`pushPage`/`prompt`) must happen synchronously: the palette
	 * closes itself when the command does neither.
	 */
	run(context: CommandContext): void | Promise<void>;
};

export type CommandContext = {
	/** Replaces the palette list with a nested page, e.g. a list of models. */
	pushPage(page: CommandPage): void;
	/** Asks for one line of text, e.g. a session name. */
	prompt(options: PromptOptions): void;
	/** Closes the palette. */
	close(): void;
};

export type CommandPage =
	| { kind: "commands"; title: string; placeholder?: string; commands: Command[] }
	| { kind: "shortcuts"; title: string };

export type PromptOptions = {
	title: string;
	initialValue?: string;
	placeholder?: string;
	/** Return `false` to keep the palette open, e.g. when the value is empty. */
	onSubmit(value: string): boolean | void | Promise<boolean | void>;
};

type Registration = { priority: number; commands: Command[] };

/** Commands keyed by the component that registered them. */
export type CommandRegistry = Map<string, Registration>;

const RegistryContext = createContext<CommandRegistry | undefined>(undefined);

/** Display order of the palette groups; unknown groups go last. */
const GROUP_ORDER = ["Session", "Chat", "App", "Help"];

function groupRank(name: string): number {
	const index = GROUP_ORDER.indexOf(name);
	return index === -1 ? GROUP_ORDER.length : index;
}

/** Flattens the registry into palette order: by registration priority, then by group. */
export function collectCommands(registry: CommandRegistry): Command[] {
	return [...registry.values()]
		.sort((a, b) => a.priority - b.priority)
		.flatMap((entry) => entry.commands)
		.map((command, index) => ({ command, index }))
		.sort((a, b) => groupRank(a.command.group) - groupRank(b.command.group) || a.index - b.index)
		.map((entry) => entry.command);
}

type PaletteControls = {
	open(): void;
	close(): void;
	toggle(): void;
	openShortcuts(): void;
};

const PaletteContext = createContext<PaletteControls | undefined>(undefined);

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return (
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.tagName === "SELECT" ||
		target.isContentEditable
	);
}

/** Holds every registered command plus the palette open state, and installs the global shortcuts. */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
	const registry = useRef<CommandRegistry>(new Map());
	const [open, setOpen] = useState(false);
	const [startPage, setStartPage] = useState<"commands" | "shortcuts">("commands");

	const controls = useMemo<PaletteControls>(
		() => ({
			open: () => {
				setStartPage("commands");
				setOpen(true);
			},
			close: () => setOpen(false),
			toggle: () => {
				setStartPage("commands");
				setOpen((current) => !current);
			},
			openShortcuts: () => {
				setStartPage("shortcuts");
				setOpen(true);
			},
		}),
		[],
	);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const mod = event.metaKey || event.ctrlKey;
			if (mod && !event.altKey && event.key.toLowerCase() === "k") {
				event.preventDefault();
				controls.toggle();
				return;
			}
			if (!mod && !event.altKey && event.key === "?" && !isTypingTarget(event.target)) {
				event.preventDefault();
				controls.openShortcuts();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [controls]);

	return (
		<RegistryContext.Provider value={registry.current}>
			<PaletteContext.Provider value={controls}>
				{children}
				<CommandPalette
					open={open}
					startPage={startPage}
					registry={registry.current}
					onClose={() => setOpen(false)}
				/>
			</PaletteContext.Provider>
		</RegistryContext.Provider>
	);
}

/**
 * Makes `commands` available to the palette while the calling component is mounted. Lower
 * priorities are listed first; the shell uses 0 and pages use 1.
 */
export function useRegisterCommands(owner: string, commands: Command[], priority = 0): void {
	const registry = useContext(RegistryContext);
	if (registry === undefined) throw new Error("useRegisterCommands must be used inside CommandPaletteProvider");
	useEffect(() => {
		registry.set(owner, { priority, commands });
		return () => {
			registry.delete(owner);
		};
	});
}

export function useCommandPalette(): PaletteControls {
	const controls = useContext(PaletteContext);
	if (controls === undefined) throw new Error("useCommandPalette must be used inside CommandPaletteProvider");
	return controls;
}
