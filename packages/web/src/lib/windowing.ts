/**
 * Windowing for the message list: a long session renders only its tail at first, growing upward
 * one page at a time as the reader scrolls up. Pure policy helpers, so they stay unit-testable.
 */

/** Entries rendered when a session opens: the newest messages a reader wants first. */
export const INITIAL_PAGE = 40;

/** Entries added each time the reader nears the top of the rendered window. */
export const PREPEND_PAGE = 30;

/** Rendered entries above which a reader back at the bottom drops the far past again. */
export const MAX_RENDERED = 160;

/** How close to the top of the scroll range (px) another prepend loads at. */
export const PRELOAD_PX = 800;

/** The first entry index to render, so the newest `page` entries show first. */
export function initialHead(total: number, page: number = INITIAL_PAGE): number {
	return Math.max(0, total - page);
}

/** Move the window up by one page; `0` is the transcript's first entry. */
export function prependHead(head: number, page: number = PREPEND_PAGE): number {
	return Math.max(0, head - page);
}

/** Keep the head inside the list after a snapshot replaced it with a shorter one. */
export function clampHead(head: number, total: number): number {
	return Math.min(head, Math.max(0, total - 1));
}

/**
 * Back to the tail window once the reader returned to the bottom and the window grew past
 * `MAX_RENDERED` entries; otherwise stay put, so scrolling down never trims what is on screen.
 */
export function trimHeadAtBottom(head: number, total: number): number {
	return total - head > MAX_RENDERED ? initialHead(total) : head;
}
