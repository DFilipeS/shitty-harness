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

export function BrainIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
			<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
			<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
			<path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
			<path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
			<path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
			<path d="M19.938 10.5a4 4 0 0 1 .585.396" />
			<path d="M6 18a4 4 0 0 1-1.967-.516" />
			<path d="M19.967 17.484A4 4 0 0 1 18 18" />
		</Svg>
	);
}

export function ChevronDownIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="m6 9 6 6 6-6" />
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

export function SearchIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<circle cx="11" cy="11" r="7" />
			<path d="m20.5 20.5-4.2-4.2" />
		</Svg>
	);
}

export function CheckIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M20 6 9 17l-5-5" />
		</Svg>
	);
}

export function ArrowLeftIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M19 12H5M12 19l-7-7 7-7" />
		</Svg>
	);
}

export function KeyboardIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<rect x="2" y="6" width="20" height="12" rx="2" />
			<path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
		</Svg>
	);
}

export function MessageIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
		</Svg>
	);
}

export function SparklesIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="m12 3 1.8 4.9L19 9.7l-5.2 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8Z" />
			<path d="m18.5 15.5.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z" />
		</Svg>
	);
}

export function LayersIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="m12 3 9 5-9 5-9-5Z" />
			<path d="m3 13 9 5 9-5" />
			<path d="m3 17 9 5 9-5" />
		</Svg>
	);
}

export function CpuIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<rect x="5" y="5" width="14" height="14" rx="2" />
			<path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
		</Svg>
	);
}

export function CommandIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
		</Svg>
	);
}

export function KeyIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="m21 2-9.6 9.6" />
			<circle cx="7.5" cy="15.5" r="5.5" />
			<path d="m15.5 7.5 3 3L22 7l-3-3" />
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

export function TerminalIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="m4 17 6-6-6-6" />
			<path d="M12 19h8" />
		</Svg>
	);
}

export function FileIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
			<path d="M14 2v4a2 2 0 0 0 2 2h4" />
		</Svg>
	);
}

export function FilePlusIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
			<path d="M14 2v4a2 2 0 0 0 2 2h4" />
			<path d="M12 12v6M9 15h6" />
		</Svg>
	);
}

export function ImageIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<circle cx="9" cy="9" r="2" />
			<path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
		</Svg>
	);
}

export function WrenchIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" />
		</Svg>
	);
}

export function SlidersIcon({ className }: IconProps) {
	return (
		<Svg className={className}>
			<path d="M4 7h16M4 17h16" />
			<circle cx="9" cy="7" r="2.5" />
			<circle cx="15" cy="17" r="2.5" />
		</Svg>
	);
}
