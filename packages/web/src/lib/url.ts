/** Session URLs look like `/sessions/<id>`; every other path means no session is open. */
const SESSION_PATH = /^\/sessions\/([^/]+)\/?$/;

/** Reads the session id from a pathname, e.g. `/sessions/42` gives `"42"`. */
export function sessionIdFromPath(pathname: string): string | undefined {
	const match = SESSION_PATH.exec(pathname);
	const id = match?.[1];
	if (id === undefined) return undefined;
	try {
		return decodeURIComponent(id);
	} catch {
		return undefined;
	}
}

/** The URL path for a session. */
export function sessionPath(id: string): string {
	return `/sessions/${encodeURIComponent(id)}`;
}
