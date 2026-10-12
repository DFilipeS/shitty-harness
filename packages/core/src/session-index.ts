import { defineDoc } from "@earendil-works/pi-durable";

/** One entry in the app's session list. */
export type SessionIndexEntry = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
};

export type SessionIndexState = {
	sessions: SessionIndexEntry[];
};

/**
 * Session-scoped index of all conversations the app knows about. Kept in one document so the
 * sidebar can be listed and ordered without scanning every conversation.
 */
export const SessionIndex = defineDoc<SessionIndexState>({
	kind: "app.session-index",
	version: 1,
	scope: "session",
	initial: () => ({ sessions: [] }),
});
