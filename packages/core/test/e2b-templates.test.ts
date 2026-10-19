import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2BProviderFactory } from "../src/sandboxes/e2b/provider.ts";

/** Records what the fake E2B Template builder was asked to do. */
const recorder = vi.hoisted(() => ({
	template: "" as string,
	commands: [] as { command: string; options: unknown }[],
}));

vi.mock("e2b", () => {
	const builder = {
		fromBaseImage: () => {
			recorder.template = "base";
			return builder;
		},
		fromTemplate: (name: string) => {
			recorder.template = `template:${name}`;
			return builder;
		},
		fromImage: (image: string) => {
			recorder.template = `image:${image}`;
			return builder;
		},
		runCmd: (command: string, options: unknown) => {
			recorder.commands.push({ command, options });
			return builder;
		},
	};
	const Template = Object.assign(() => builder, {
		buildInBackground: async (_template: unknown, name: string) => ({
			templateId: `tpl-${name}`,
			buildId: `build-${name}`,
		}),
		getBuildStatus: async () => ({
			status: "ready",
			logEntries: [{ message: "layer cached" }],
		}),
	});
	return { Template };
});

describe("E2B template builds", () => {
	it("runs every recipe command as root, from the recipe's source", async () => {
		recorder.template = "";
		recorder.commands = [];
		const provider = E2BProviderFactory.create({}, { apiKey: "test-key" });
		const logs: string[] = [];
		const result = await provider.buildTemplate?.(
			{
				name: "tools",
				source: { kind: "template", name: "harness-base" },
				run: ["apt-get update", "true"],
			},
			(line) => logs.push(line),
		);
		expect(recorder.template).toBe("template:harness-base");
		expect(recorder.commands).toEqual([
			{ command: "apt-get update", options: { user: "root" } },
			{ command: "true", options: { user: "root" } },
		]);
		expect(result).toEqual({ templateId: "tpl-tools", buildId: "build-tools" });
		expect(logs).toEqual(["layer cached"]);
	});

	it("starts from the provider base image when the recipe names none", async () => {
		recorder.template = "";
		recorder.commands = [];
		const provider = E2BProviderFactory.create({}, { apiKey: "test-key" });
		await provider.buildTemplate?.(
			{ name: "plain", source: { kind: "default" }, run: [] },
			() => {},
		);
		expect(recorder.template).toBe("base");
		expect(recorder.commands).toEqual([]);
	});
});

type Handler = (request: IncomingMessage, response: ServerResponse, url: URL) => void;

async function listen(handler: Handler): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((request, response) => {
		void handler(request, response, new URL(request.url ?? "/", "http://localhost"));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function close(server: Server): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("E2B templates over REST", () => {
	const original = process.env.E2B_API_URL;
	afterEach(() => {
		if (original === undefined) delete process.env.E2B_API_URL;
		else process.env.E2B_API_URL = original;
	});

	it("lists templates, following the next-token header", async () => {
		const { server, baseUrl } = await listen((_request, response, url) => {
			if (url.searchParams.get("nextToken") === "two") {
				response
					.writeHead(200, { "content-type": "application/json" })
					.end(
						JSON.stringify([
							{ templateID: "tpl-2", names: ["project/second:default"], buildID: "b2" },
						]),
					);
				return;
			}
			response.writeHead(200, { "content-type": "application/json", "x-next-token": "two" }).end(
				JSON.stringify([
					{
						templateID: "tpl-1",
						names: ["project/first:default"],
						buildID: "b1",
						buildStatus: "ready",
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-02T00:00:00.000Z",
						spawnCount: 3,
						public: false,
					},
				]),
			);
		});
		process.env.E2B_API_URL = baseUrl;
		try {
			const provider = E2BProviderFactory.create({}, { apiKey: "test-key" });
			const templates = await provider.listTemplates?.();
			expect(templates?.map((template) => template.templateId)).toEqual(["tpl-1", "tpl-2"]);
			expect(templates?.[0]).toMatchObject({
				names: ["project/first:default"],
				buildId: "b1",
				buildStatus: "ready",
				spawnCount: 3,
				public: false,
			});
			expect(templates?.[0]?.createdAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
		} finally {
			await close(server);
		}
	});

	it("sends the API key and treats a missing template as already gone", async () => {
		const calls: { method: string; path: string; key: string | undefined }[] = [];
		const { server, baseUrl } = await listen((request, response, url) => {
			calls.push({
				method: request.method ?? "",
				path: url.pathname,
				key: request.headers["x-api-key"] as string | undefined,
			});
			if (request.method === "DELETE") {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, { "content-type": "application/json" }).end("[]");
		});
		process.env.E2B_API_URL = baseUrl;
		try {
			const provider = E2BProviderFactory.create({}, { apiKey: "secret-key" });
			await provider.listTemplates?.();
			await expect(provider.deleteTemplate?.("tpl-gone")).resolves.toBeUndefined();
			expect(calls).toEqual([
				{ method: "GET", path: "/v2/templates", key: "secret-key" },
				{ method: "DELETE", path: "/templates/tpl-gone", key: "secret-key" },
			]);
		} finally {
			await close(server);
		}
	});

	it("maps an unauthorized list to an auth error", async () => {
		const { server, baseUrl } = await listen((_request, response) => {
			response.writeHead(401, { "content-type": "application/json" }).end("{}");
		});
		process.env.E2B_API_URL = baseUrl;
		try {
			const provider = E2BProviderFactory.create({}, { apiKey: "wrong" });
			await expect(provider.listTemplates?.()).rejects.toMatchObject({ code: "auth" });
		} finally {
			await close(server);
		}
	});
});
