import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

export type MarkdownVariant = "assistant" | "user";

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
 * Assistant text follows the theme tokens, so it flips with light and dark. The user bubble keeps
 * a light background in both themes, so its palette stays fixed. Code blocks are dark in both.
 */
const PALETTES: Record<MarkdownVariant, MarkdownPalette> = {
	assistant: {
		text: "text-fg",
		link: "text-link underline decoration-link/40 underline-offset-2 hover:decoration-link",
		blockquote: "border-line-strong text-fg-muted",
		hr: "border-line",
		tableHead: "border-line-strong",
		tableHeaderCell: "text-fg-muted",
		tableCell: "border-line",
		code: "bg-raised text-fg",
		checkbox: "accent-fg-muted",
	},
	user: {
		text: "text-user-fg",
		link: "text-sky-700 underline decoration-sky-700/40 underline-offset-2 hover:decoration-sky-700",
		blockquote: "border-user-line text-zinc-600",
		hr: "border-user-line",
		tableHead: "border-user-line",
		tableHeaderCell: "text-zinc-600",
		tableCell: "border-user-line",
		code: "bg-user-raised text-user-fg",
		checkbox: "accent-zinc-600",
	},
};

/**
 * Markdown for message text. Raw HTML is not enabled, so model output cannot inject markup; links
 * open in a new tab. `remark-breaks` keeps single newlines visible, matching how chat UIs treat
 * model output. `rehype-highlight` adds `hljs-*` classes, styled in `index.css`.
 */
function componentsFor(palette: MarkdownPalette): Components {
	return {
		a: ({ href, children }) => (
			<a href={href} target="_blank" rel="noreferrer noopener" className={palette.link}>
				{children}
			</a>
		),
		p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
		ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>,
		ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>,
		li: ({ children }) => <li className="pl-0.5">{children}</li>,
		h1: ({ children }) => <h1 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h1>,
		h2: ({ children }) => <h2 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h2>,
		h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>,
		h4: ({ children }) => <h4 className="mt-3 mb-1.5 text-sm font-medium first:mt-0">{children}</h4>,
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
		th: ({ children }) => <th className={`px-2 py-1.5 font-medium ${palette.tableHeaderCell}`}>{children}</th>,
		td: ({ children }) => (
			<td className={`border-t px-2 py-1.5 align-top ${palette.tableCell}`}>{children}</td>
		),
		pre: ({ children }) => (
			<pre className="my-2 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100 first:mt-0 last:mb-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
				{children}
			</pre>
		),
		code: ({ className, children }) => (
			<code className={`rounded px-1 py-0.5 font-mono text-[0.85em] ${palette.code} ${className ?? ""}`}>
				{children}
			</code>
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
};

export const Markdown = memo(function Markdown({
	text,
	variant = "assistant",
}: {
	text: string;
	variant?: MarkdownVariant;
}) {
	return (
		<div className={`text-sm leading-relaxed ${PALETTES[variant].text}`}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm, remarkBreaks]}
				rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
				components={COMPONENTS[variant]}
			>
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
