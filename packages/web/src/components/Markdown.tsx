import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * Markdown for assistant text. Raw HTML is not enabled, so model output cannot inject markup;
 * links open in a new tab. `remark-breaks` keeps single newlines visible, matching how chat UIs
 * treat model output. `rehype-highlight` adds `hljs-*` classes, styled in `index.css`.
 */
const components: Components = {
	a: ({ href, children }) => (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			className="text-sky-400 underline decoration-sky-400/40 underline-offset-2 hover:decoration-sky-400"
		>
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
		<blockquote className="my-2 border-l-2 border-zinc-700 pl-3 text-zinc-400 first:mt-0 last:mb-0">
			{children}
		</blockquote>
	),
	hr: () => <hr className="my-3 border-zinc-800" />,
	table: ({ children }) => (
		<div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
			<table className="w-full border-collapse text-left text-xs">{children}</table>
		</div>
	),
	thead: ({ children }) => <thead className="border-b border-zinc-700">{children}</thead>,
	th: ({ children }) => <th className="px-2 py-1.5 font-medium text-zinc-300">{children}</th>,
	td: ({ children }) => <td className="border-t border-zinc-800/70 px-2 py-1.5 align-top">{children}</td>,
	pre: ({ children }) => (
		<pre className="my-2 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs leading-relaxed first:mt-0 last:mb-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
			{children}
		</pre>
	),
	code: ({ className, children }) => (
		<code
			className={`rounded bg-zinc-800/70 px-1 py-0.5 font-mono text-[0.85em] text-zinc-200 ${className ?? ""}`}
		>
			{children}
		</code>
	),
	input: ({ node: _node, checked, ...props }) => (
		<input {...props} defaultChecked={checked === true} disabled className="mr-1.5 h-3.5 w-3.5 accent-zinc-400" />
	),
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="text-sm leading-relaxed text-zinc-100">
			<ReactMarkdown
				remarkPlugins={[remarkGfm, remarkBreaks]}
				rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
				components={components}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
