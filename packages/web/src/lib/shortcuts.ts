/**
 * Keyboard bindings shared by the palette commands and the composer chips.
 *
 * The model and thinking level deliberately have no binding: Cmd+Shift+M and Cmd+Shift+T
 * are taken by Chrome (profile switcher and reopen closed tab), and the browser wins over
 * the page. Cmd/Ctrl+Shift+B, a natural mirror of the sidebar's mod+b, is out for the same
 * reason: Chrome toggles its bookmarks bar with it. The session panel takes mod+i instead.
 */
export const SHORTCUTS = {
	palette: "mod+k",
	sidebar: "mod+b",
	sessionPanel: "mod+i",
	help: "?",
} as const;
