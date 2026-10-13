import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "harness-theme";

/** The theme the inline script in index.html already applied to <html>. */
function activeTheme(): Theme {
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

type ThemeContextValue = {
	theme: Theme;
	toggleTheme(): void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/** Shares one theme state across the app, so a palette command and the sidebar button agree. */
export function ThemeProvider({ children }: { children: ReactNode }) {
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
	const value = useMemo<ThemeContextValue>(() => ({ theme, toggleTheme }), [theme, toggleTheme]);
	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
	const value = useContext(ThemeContext);
	if (value === undefined) throw new Error("useTheme must be used inside ThemeProvider");
	return value;
}
