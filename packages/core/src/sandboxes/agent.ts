import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** True when the agent at `socket` responds and has at least one identity. */
async function agentHasIdentities(socket: string): Promise<boolean> {
	try {
		await execFileAsync("ssh-add", ["-l"], { env: { ...process.env, SSH_AUTH_SOCK: socket } });
		return true;
	} catch {
		return false;
	}
}

/** Effective `IdentityAgent` from the user's OpenSSH config, if any. */
async function sshConfigAgentSocket(): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("ssh", ["-G", "example.com"]);
		const match = /^identityagent\s+(.+)$/m.exec(stdout);
		const raw = match?.[1];
		const value = raw?.trim().replace(/^"(.*)"$/, "$1");
		if (!value || value === "none") return undefined;
		// OpenSSH prints the literal token when the default is in effect.
		if (value === "SSH_AUTH_SOCK") return process.env.SSH_AUTH_SOCK || undefined;
		return value;
	} catch {
		return undefined;
	}
}

/**
 * Find the host SSH agent socket to forward.
 *
 * Order: the configured socket, then `SSH_AUTH_SOCK` when it has identities, then the OpenSSH
 * `IdentityAgent` setting. The order matters on macOS: the environment often points at an empty
 * launchd agent while the real keys live behind an `IdentityAgent` (1Password, Secretive, ...).
 */
export async function resolveHostAgentSocket(configured?: string): Promise<string | undefined> {
	if (configured !== undefined && configured !== "") return configured;
	const fromEnv = process.env.SSH_AUTH_SOCK;
	if (fromEnv !== undefined && fromEnv !== "" && (await agentHasIdentities(fromEnv))) return fromEnv;
	const fromConfig = await sshConfigAgentSocket();
	if (fromConfig !== undefined) return fromConfig;
	return fromEnv === "" ? undefined : fromEnv;
}
