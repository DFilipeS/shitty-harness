/** Quote one argv element so a POSIX shell passes it through unchanged. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
