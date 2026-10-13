import { useCallback, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "harness-theme";

/** The theme the inline script in index.html already applied to <html>. */
function activeTheme(): Theme {
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Reads the applied theme and toggles it, persisting the choice for the next visit. */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
	const [theme, setTheme] = useState<Theme>(activeTheme);
	const toggleTheme = useCallback(() => {
		setTheme((current) => {
			const next: Theme = current === "dark" ? "light" : "dark";
			document.documentElement.classList.toggle("dark", next === "dark");
			try {
				localStorage.setItem(STORAGE_KEY, next);
			} catch {
				// Storage can be unavailable; the choice then lasts for this page only.
			}
			return next;
		});
	}, []);
	return { theme, toggleTheme };
}
