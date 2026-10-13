import type { ReactNode } from "react";

type IconProps = {
	className?: string;
};

function Svg({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className ?? "h-4 w-4"}
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export function PlusIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M12 5v14M5 12h14" />
		</Svg>
	);
}

export function SunIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
		</Svg>
	);
}

export function MoonIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
		</Svg>
	);
}

export function MenuIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M4 6h16M4 12h16M4 18h16" />
		</Svg>
	);
}

export function SettingsIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.96a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.04Z" />
		</Svg>
	);
}

export function StopIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
		</Svg>
	);
}

export function SendIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M12 19V5M5 12l7-7 7 7" />
		</Svg>
	);
}

export function PencilIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
		</Svg>
	);
}

export function XIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M18 6 6 18M6 6l12 12" />
		</Svg>
	);
}

export function TrashIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
		</Svg>
	);
}

export function RefreshIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />
		</Svg>
	);
}
