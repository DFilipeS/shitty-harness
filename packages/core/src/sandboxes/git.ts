import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SandboxError, type SandboxHandle } from "./provider.ts";
import { shellQuote } from "./shell.ts";

const execFileAsync = promisify(execFile);

/** Read the host Git identity so commits made in the sandbox are attributed correctly. */
export async function hostGitIdentity(): Promise<{ name?: string; email?: string }> {
	const read = async (key: string): Promise<string | undefined> => {
		try {
			const { stdout } = await execFileAsync("git", ["config", "--global", "--get", key]);
			return stdout.trim() || undefined;
		} catch {
			return undefined;
		}
	};
	return { name: await read("user.name"), email: await read("user.email") };
}

/** Copy the host identity into the sandbox's global Git config. */
export async function applyGitIdentity(
	handle: SandboxHandle,
	identity: { name?: string; email?: string },
): Promise<void> {
	if (identity.name !== undefined) {
		await handle.exec(`git config --global user.name ${shellQuote(identity.name)}`);
	}
	if (identity.email !== undefined) {
		await handle.exec(`git config --global user.email ${shellQuote(identity.email)}`);
	}
}

export type CloneOptions = {
	/** Extra environment, e.g. `SSH_AUTH_SOCK` for a forwarded agent. */
	env?: Record<string, string>;
};

/**
 * Clone a repository into the sandbox workspace. The clone trusts a host key on first use and
 * never prompts, so a forwarded SSH agent is the only way to authenticate.
 */
export async function cloneIntoWorkspace(
	handle: SandboxHandle,
	url: string,
	options: CloneOptions = {},
): Promise<void> {
	const stderr: string[] = [];
	const result = await handle.exec(`git clone -- ${shellQuote(url)} ${shellQuote(handle.workspaceDir)}`, {
		env: {
			GIT_TERMINAL_PROMPT: "0",
			GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
			...options.env,
		},
		onStderr: (text) => {
			stderr.push(text);
		},
	});
	if (result.exitCode === 0) return;
	const detail = stderr.join("").trim().split("\n").slice(-3).join("\n");
	throw new SandboxError("unknown", `git clone failed${detail === "" ? "" : `: ${detail}`}`);
}
