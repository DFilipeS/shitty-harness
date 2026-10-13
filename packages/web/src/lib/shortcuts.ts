/**
 * Keyboard bindings shared by the palette commands and the composer chips.
 *
 * The model and thinking level deliberately have no binding: Cmd+Shift+M and Cmd+Shift+T
 * are taken by Chrome (profile switcher and reopen closed tab), and the browser wins over
 * the page.
 */
export const SHORTCUTS = {
	palette: "mod+k",
	sidebar: "mod+b",
	help: "?",
} as const;
