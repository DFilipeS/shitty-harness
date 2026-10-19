import { memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import hljs from "highlight.js/lib/common";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

export type MarkdownVariant = "assistant" | "user" | "thinking";
export type MarkdownSize = "sm" | "xs";

type MarkdownPalette = {
	text: string;
	link: string;
	blockquote: string;
	hr: string;
	tableHead: string;
	tableHeaderCell: string;
	tableCell: string;
	code: string;
	checkbox: string;
};

/**
 * Highlighted HTML for one fenced block, keyed by `language\u0000code`. A re-render (or switching
 * back to a session that stayed mounted) reads the cache instead of re-running highlight.js.
 */
const highlightCache = new Map<string, string | null>();
const HIGHLIGHT_CACHE_LIMIT = 400;

/** Lazy highlights waiting for an idle slot, at most one entry per key (the newest wins). */
const highlightQueue = new Map<string, () => void>();
let pumpScheduled = false;

const requestIdle: (callback: () => void) => number =
	typeof window !== "undefined" && typeof window.requestIdleCallback === "function"
		? (callback) => window.requestIdleCallback(() => callback(), { timeout: 200 })
		: (callback) => window.setTimeout(callback, 32);

/** Highlight one block per idle slot, so the pass never blocks a frame that paint or input needs. */
function pumpHighlightQueue(): void {
	pumpScheduled = false;
	const [entry] = highlightQueue;
	if (entry === undefined) return;
	highlightQueue.delete(entry[0]);
	entry[1]();
	if (highlightQueue.size > 0) scheduleHighlightPump();
}

function scheduleHighlightPump(): void {
	if (pumpScheduled) return;
	pumpScheduled = true;
	requestIdle(pumpHighlightQueue);
}

/** highlight.js HTML for one block, or `null` when it cannot be highlighted. */
function computeHighlight(language: string, code: string): string | null {
	if (hljs.getLanguage(language) === undefined) return null;
	try {
		return hljs.highlight(code, { language, ignoreIllegals: true }).value;
	} catch {
		return null;
	}
}

/** The cached HTML for a block, if it was ever highlighted; `undefined` means not yet. */
function readHighlight(key: string): string | null | undefined {
	if (!highlightCache.has(key)) return undefined;
	const hit = highlightCache.get(key) ?? null;
	highlightCache.delete(key);
	highlightCache.set(key, hit); // Refresh LRU recency.
	return hit;
}

/** The HTML for a block, computing and remembering it on the first ask. */
function cachedHighlight(key: string, language: string, code: string): string | null {
	const known = readHighlight(key);
	if (known !== undefined) return known;
	const html = computeHighlight(language, code);
	highlightCache.set(key, html);
	if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
		const oldest = highlightCache.keys().next().value;
		if (oldest !== undefined) highlightCache.delete(oldest);
	}
	return html;
}

/**
 * A fenced code block with a language tag. The plain text paints first, so opening a session is
 * not held up by syntax highlighting; the colors follow from an idle-time pass and pop in. The
 * cache makes the second view of the same block immediate, colors and all. During streaming the
 * text keeps changing, so a stale queued highlight is skipped by its cancellation flag.
 */
function LazyCode({
	language,
	code,
	className,
}: {
	language: string;
	code: string;
	className: string;
}) {
	const key = `${language}\u0000${code}`;
	// `undefined` = not highlighted yet (plain text), `null` = cannot be, a string = colored in.
	const [html, setHtml] = useState<string | null | undefined>(() => readHighlight(key));
	useEffect(() => {
		const known = readHighlight(key);
		if (known !== undefined) {
			setHtml(known);
			return;
		}
		let cancelled = false;
		highlightQueue.set(key, () => {
			if (cancelled) return;
			setHtml(cachedHighlight(key, language, code));
		});
		scheduleHighlightPump();
		return () => {
			cancelled = true;
		};
	}, [key, language, code]);
	return (
		<code className={`hljs ${className}`}>
			{typeof html === "string" ? (
				<span data-lazy-highlight dangerouslySetInnerHTML={{ __html: html }} />
			) : (
				code
			)}
		</code>
	);
}

/** The `language-…` class of a fenced block, when it carries one. */
function languageOfClass(className: string | undefined): string | undefined {
	return /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1];
}

/** Code blocks pass through as one text child; other children render as best-effort text. */
function textOf(children: ReactNode): string {
	return Array.isArray(children)
		? children.map((child) => textOf(child)).join("")
		: typeof children === "string" || typeof children === "number"
			? String(children)
			: "";
}

/** The `code` element for one palette: lazy-highlighted fences, plain text for the rest. */
function codeComponent(paletteCode: string) {
	return function Code({ className, children }: { className?: string; children?: ReactNode }) {
		const language = languageOfClass(className);
		const shared = `rounded px-1 py-0.5 font-mono text-[0.85em] ${paletteCode} ${className ?? ""}`;
		if (language === undefined) return <code className={shared}>{children}</code>;
		return <LazyCode language={language} code={textOf(children)} className={shared} />;
	};
}

/**
 * Assistant text follows the theme tokens, so it flips with light and dark. The user bubble keeps
 * a light background in both themes, so its palette stays fixed. Code blocks are dark in both.
 */
const assistantPalette: MarkdownPalette = {
	text: "text-fg",
	link: "text-link underline decoration-link/40 underline-offset-2 hover:decoration-link",
	blockquote: "border-line-strong text-fg-muted",
	hr: "border-line",
	tableHead: "border-line-strong",
	tableHeaderCell: "text-fg-muted",
	tableCell: "border-line",
	code: "bg-raised text-fg",
	checkbox: "accent-fg-muted",
};

const userPalette: MarkdownPalette = {
	text: "text-user-fg",
	link: "text-sky-700 underline decoration-sky-700/40 underline-offset-2 hover:decoration-sky-700",
	blockquote: "border-user-line text-zinc-600",
	hr: "border-user-line",
	tableHead: "border-user-line",
	tableHeaderCell: "text-zinc-600",
	tableCell: "border-user-line",
	code: "bg-user-raised text-user-fg",
	checkbox: "accent-zinc-600",
};

const PALETTES: Record<MarkdownVariant, MarkdownPalette> = {
	assistant: assistantPalette,
	user: userPalette,
	thinking: { ...assistantPalette, text: "text-fg-muted" },
};

/**
 * Markdown for message text. Raw HTML is not enabled, so model output cannot inject markup; links
 * open in a new tab. `remark-breaks` keeps single newlines visible, matching how chat UIs treat
 * model output. Fenced blocks with a language tag highlight lazily (`hljs-*` classes, styled in
 * `index.css`): plain text first, colors from an idle-time pass.
 */
function componentsFor(palette: MarkdownPalette): Components {
	const code = codeComponent(palette.code);
	return {
		code,
		a: ({ href, children }) => (
			<a href={href} target="_blank" rel="noreferrer noopener" className={palette.link}>
				{children}
			</a>
		),
		p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
		ul: ({ children }) => (
			<ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>
		),
		ol: ({ children }) => (
			<ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>
		),
		li: ({ children }) => <li className="pl-0.5">{children}</li>,
		h1: ({ children }) => (
			<h1 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h1>
		),
		h2: ({ children }) => (
			<h2 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h2>
		),
		h3: ({ children }) => (
			<h3 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>
		),
		h4: ({ children }) => (
			<h4 className="mt-3 mb-1.5 text-sm font-medium first:mt-0">{children}</h4>
		),
		blockquote: ({ children }) => (
			<blockquote className={`my-2 border-l-2 pl-3 first:mt-0 last:mb-0 ${palette.blockquote}`}>
				{children}
			</blockquote>
		),
		hr: () => <hr className={`my-3 border-t ${palette.hr}`} />,
		table: ({ children }) => (
			<div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
				<table className="w-full border-collapse text-left text-xs">{children}</table>
			</div>
		),
		thead: ({ children }) => <thead className={`border-b ${palette.tableHead}`}>{children}</thead>,
		th: ({ children }) => (
			<th className={`px-2 py-1.5 font-medium ${palette.tableHeaderCell}`}>{children}</th>
		),
		td: ({ children }) => (
			<td className={`border-t px-2 py-1.5 align-top ${palette.tableCell}`}>{children}</td>
		),
		pre: ({ children }) => (
			<pre className="my-2 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100 first:mt-0 last:mb-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
				{children}
			</pre>
		),
		input: ({ node: _node, checked, ...props }) => (
			<input
				{...props}
				defaultChecked={checked === true}
				disabled
				className={`mr-1.5 h-3.5 w-3.5 ${palette.checkbox}`}
			/>
		),
	};
}

const COMPONENTS: Record<MarkdownVariant, Components> = {
	assistant: componentsFor(PALETTES.assistant),
	user: componentsFor(PALETTES.user),
	thinking: componentsFor(PALETTES.thinking),
};

export const Markdown = memo(function Markdown({
	text,
	variant = "assistant",
	size = "sm",
}: {
	text: string;
	variant?: MarkdownVariant;
	size?: MarkdownSize;
}) {
	return (
		<div
			className={`${size === "xs" ? "text-xs" : "text-sm"} leading-relaxed ${PALETTES[variant].text}`}
		>
			<ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={COMPONENTS[variant]}>
				{text}
			</ReactMarkdown>
		</div>
	);
});

/**
 * Block elements collapse to inline content so single-line text stays truncatable (`text-overflow:
 * ellipsis` only applies to a container's own inline content). Links render as styled text because
 * a title click already has a meaning.
 */
const inlineComponents: Components = {
	p: ({ children }) => <>{children}</>,
	h1: ({ children }) => <span className="font-semibold">{children}</span>,
	h2: ({ children }) => <span className="font-semibold">{children}</span>,
	h3: ({ children }) => <span className="font-semibold">{children}</span>,
	h4: ({ children }) => <span className="font-semibold">{children}</span>,
	h5: ({ children }) => <span className="font-semibold">{children}</span>,
	h6: ({ children }) => <span className="font-semibold">{children}</span>,
	blockquote: ({ children }) => <>{children}</>,
	pre: ({ children }) => <>{children}</>,
	ul: ({ children }) => <>{children}</>,
	ol: ({ children }) => <>{children}</>,
	li: ({ children }) => <>{children}</>,
	hr: () => null,
	a: ({ children }) => (
		<span className="underline decoration-current/40 underline-offset-2">{children}</span>
	),
	code: ({ className, children }) => (
		<code className={`rounded bg-raised px-1 py-0.5 font-mono text-[0.85em] ${className ?? ""}`}>
			{children}
		</code>
	),
	del: ({ children }) => <del className="opacity-70">{children}</del>,
};

/** Inline-only markdown for single-line text such as session titles. */
export const MarkdownInline = memo(function MarkdownInline({ text }: { text: string }) {
	return (
		<span>
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={inlineComponents}>
				{text}
			</ReactMarkdown>
		</span>
	);
});
