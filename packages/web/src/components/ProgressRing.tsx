/**
 * Small ring that fills clockwise to `percent` (0-100). Uses the current text color, so callers
 * color it by putting it inside a colored span.
 */
export function ProgressRing({ percent, className }: { percent: number; className?: string }) {
	const radius = 5;
	const circumference = 2 * Math.PI * radius;
	const filled = Math.max(0, Math.min(100, percent));
	return (
		<svg
			viewBox="0 0 12 12"
			className={`h-3 w-3 shrink-0 ${className ?? ""}`}
			aria-hidden="true"
			fill="none"
			strokeWidth="2"
		>
			<circle cx="6" cy="6" r={radius} className="stroke-current opacity-20" />
			{filled > 0 && (
				<circle
					cx="6"
					cy="6"
					r={radius}
					className="stroke-current"
					strokeDasharray={`${(circumference * filled) / 100} ${circumference}`}
					strokeLinecap="round"
					transform="rotate(-90 6 6)"
				/>
			)}
		</svg>
	);
}
