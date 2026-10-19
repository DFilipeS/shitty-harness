/** An in-memory `localStorage` stand-in; tests run in Node, where the real one is unavailable. */
export function fakeStorage(initial: Record<string, string> = {}): Storage {
	const items = new Map(Object.entries(initial));
	return {
		get length() {
			return items.size;
		},
		key: (index) => [...items.keys()][index] ?? null,
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => {
			items.set(key, String(value));
		},
		removeItem: (key) => {
			items.delete(key);
		},
		clear: () => {
			items.clear();
		},
	};
}
