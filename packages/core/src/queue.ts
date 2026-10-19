import type { InboxItem } from "@earendil-works/pi-durable";
import { isImageMimeType, type QueuedMessageInfo } from "@harness/protocol";

/**
 * The inbox view the queue display needs. The inbox also holds queued writes (compaction
 * summaries), which are not user messages; those are left out.
 */

/** The note `buildPromptContent` adds when attachments were saved into the workspace. */
const SAVED_FILES_NOTE = "Attached files saved in the working directory:";

/** One `- name (mime): \`path\`` line of the saved-files note. */
const NOTE_LINE = /^- (.+) \(([^)]+)\): `.*`$/;

/** The opening of a skill block, whose first attribute is the skill's name. */
const SKILL_BLOCK = /^<skill name="([^"]*)" scope="[^"]*">[\s\S]*<\/skill>$/;

/** The opening of an `<attached-file>` block, whose first attribute is the file's name. */
const ATTACHED_FILE = /^<attached-file name="([^"]*)" mime="[^"]*">/;

/** Reverse of the attribute escaping the skill and attachment wrappers apply. */
function unescapeAttribute(value: string): string {
	return value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

/** One queued input as the queue display shows it, or undefined for a queued write. */
export function queuedMessageInfo(item: InboxItem): QueuedMessageInfo | undefined {
	if (item.mode === "write") return undefined;
	return { id: String(item.id), mode: item.mode, ...describeContent(item.content) };
}

/**
 * What a queued message's content says in plain terms. The model content wraps each attachment and
 * skill in blocks the model reads; the display wants the user's own text, the file names, and how
 * many images the message carries.
 */
function describeContent(content: unknown): Omit<QueuedMessageInfo, "id" | "mode"> {
	if (typeof content === "string") return { text: content, attachments: [], images: 0 };
	if (!Array.isArray(content)) return { text: "", attachments: [], images: 0 };

	const texts: string[] = [];
	const named: string[] = [];
	const tagged: string[] = [];
	let images = 0;
	let skill: string | undefined;

	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		if (part.type === "image") {
			images += 1;
			continue;
		}
		if (typeof (part as { text?: unknown }).text !== "string") continue;
		const text = (part as { text: string }).text;

		const skillName = SKILL_BLOCK.exec(text)?.[1];
		if (skillName !== undefined) {
			skill = unescapeAttribute(skillName);
			continue;
		}
		if (text.startsWith(SAVED_FILES_NOTE)) {
			for (const line of text.split("\n").slice(1)) {
				const match = NOTE_LINE.exec(line);
				if (match?.[1] === undefined || match[2] === undefined) continue;
				if (isImageMimeType(match[2])) continue;
				named.push(match[1]);
			}
			continue;
		}
		const fileName = ATTACHED_FILE.exec(text)?.[1];
		if (fileName !== undefined) {
			tagged.push(unescapeAttribute(fileName));
			continue;
		}
		texts.push(text);
	}
	// The saved-files note names every attachment; without it, the wrappers are the next best source.
	const attachments = named.length > 0 ? named : tagged;
	return {
		text: texts.join("\n").trim(),
		attachments,
		images,
		...(skill === undefined ? {} : { skill }),
	};
}
