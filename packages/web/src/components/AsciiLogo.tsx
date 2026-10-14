/**
 * Blocky π drawn on a dot grid: `#` marks a dot. Every row is the same length so the grid lines up.
 * The shape steps in below the bar, leaving a notch between the legs.
 */
const ART = [
	"###################",
	"###################",
	"###################",
	"###################",
	"###################",
	"#########.....#####",
	"#########.....#####",
	"#########.....#####",
	"#####.........#####",
	"#####.........#####",
	"#####.........#####",
	"#####.........#####",
	"#####.........#####",
	"#####.........#####",
	"#####.........#####",
	"#####.........#####",
];

/** Blends two hex colors; `t` runs 0 to 1. */
function mix(from: string, to: string, t: number): string {
	const channel = (index: number) => {
		const start = Number.parseInt(from.slice(index, index + 2), 16);
		const end = Number.parseInt(to.slice(index, index + 2), 16);
		return Math.round(start + (end - start) * t)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** Orange bar on top, then a blue left leg and a yellow right leg, each with a slight fade. */
function dotColor(row: number, col: number): string {
	if (row <= 7) return mix("#ff4b3e", "#ff9f43", row / 7);
	const t = (row - 8) / (ART.length - 9);
	if (col <= 4) return mix("#63b3ff", "#2f6fd8", t);
	return mix("#ffd75e", "#e3a52f", t);
}

/** Deterministic starfield so every render (and every reload) looks the same. */
const STARS = (() => {
	let seed = 7;
	const random = () => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return seed / 4294967296;
	};
	return Array.from({ length: 34 }, () => ({
		left: random() * 100,
		top: random() * 100,
		delay: Math.round(random() * 4000),
		duration: 1800 + Math.round(random() * 3200),
		size: random() < 0.25 ? 2 : 1,
	}));
})();

/** Decorative dot-matrix π on a starfield, shown while a conversation is empty. */
export function AsciiLogo() {
	return (
		<div
			data-ascii-logo
			aria-hidden="true"
			className="relative overflow-hidden rounded-2xl border border-line bg-[#0b0e14] px-10 py-9 shadow-sm"
		>
			{STARS.map((star, index) => (
				<span
					key={index}
					className="absolute rounded-full bg-white opacity-30 motion-safe:animate-[star-twinkle_2s_ease-in-out_infinite]"
					style={{
						left: `${star.left}%`,
						top: `${star.top}%`,
						width: star.size,
						height: star.size,
						animationDelay: `${star.delay}ms`,
						animationDuration: `${star.duration}ms`,
					}}
				/>
			))}
			<div className="relative flex flex-col gap-[3px]">
				{ART.map((line, row) => (
					<div key={row} className="flex gap-[3px]">
						{[...line].map((cell, col) =>
							cell === "#" ? (
								<span
									key={col}
									className="h-1 w-1 rounded-full motion-safe:animate-[dot-shimmer_3.6s_ease-in-out_infinite]"
									style={{
										backgroundColor: dotColor(row, col),
										animationDelay: `${(row + col) * 35}ms`,
									}}
								/>
							) : (
								<span key={col} className="h-1 w-1" />
							),
						)}
					</div>
				))}
			</div>
		</div>
	);
}
