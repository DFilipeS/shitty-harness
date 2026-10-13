/** π in block characters. Every row is the same width so the glyphs line up in a monospace font. */
const ART = [
	"██████████████████████████",
	"██████████████████████████",
	"    ██████      ██████    ",
	"    ██████      ██████    ",
	"    ██████      ██████    ",
	"    ██████      ██████    ",
	"    ██████      ██████    ",
	"    ██████      ██████    ",
	"    ██████      ██████    ",
];

/** Decorative π with a diagonal shimmer, shown while a conversation is empty. */
export function AsciiLogo() {
	return (
		<pre
			aria-hidden="true"
			className="font-mono text-xs leading-none text-fg-subtle select-none"
			style={{ fontSize: "clamp(0.55rem, 2.2vw, 0.75rem)" }}
		>
			{ART.map((line, row) => (
				<span key={row} className="block">
					{[...line].map((char, column) =>
						char === " " ? (
							" "
						) : (
							<span
								// The delay grows along the row and column, so the wave travels diagonally.
								key={column}
								className="motion-safe:animate-[ascii-shimmer_2.4s_ease-in-out_infinite]"
								style={{ animationDelay: `${(row + column) * 40}ms` }}
							>
								{char}
							</span>
						),
					)}
				</span>
			))}
		</pre>
	);
}
