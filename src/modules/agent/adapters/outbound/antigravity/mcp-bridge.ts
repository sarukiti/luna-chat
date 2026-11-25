import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { z } from "zod";

import type { LoggerPort } from "../../../../observability/ports/logger-port";
import type { AgentTool, AgentToolResult } from "../../../ports/outbound/agent-session-port";
import type { AcpMcpServerConfig } from "./acp-protocol";

const DEFAULT_MCP_PROTOCOL_VERSION = "2025-11-25";
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const mcpRequestSchema = z.looseObject({
	jsonrpc: z.literal("2.0").optional(),
	id: z.union([z.number(), z.string()]).optional(),
	method: z.string(),
	params: z.unknown().optional(),
});

const mcpInitializeParamsSchema = z.looseObject({
	protocolVersion: z.string().optional(),
});

const mcpToolCallParamsSchema = z.looseObject({
	name: z.string().min(1),
	arguments: z.unknown().optional(),
});

type RegisteredSession = Readonly<{
	token: string;
	tools: ReadonlyMap<string, AgentTool>;
	toolList: readonly AgentTool[];
	getRunSignal: () => AbortSignal | undefined;
}>;

export type McpSessionRegistration = Readonly<{
	serverConfig: AcpMcpServerConfig;
	unregister(): void;
}>;

// Luna プロセス内で 127.0.0.1 の Streamable HTTP MCP サーバーを 1 本立て、
// セッションごとのルートと Bearer トークンで Luna のツールを agy acp へ公開する。
export class LocalMcpBridge {
	readonly #logger: LoggerPort;
	readonly #sessions = new Map<string, RegisteredSession>();
	#server: Server | undefined;
	#port: number | undefined;

	constructor(logger: LoggerPort) {
		this.#logger = logger;
	}

	async start(): Promise<void> {
		if (this.#server !== undefined) return;
		const server = createServer((request, response) => {
			void this.#handleRequest(request, response).catch((error: unknown) => {
				this.#logger.error("agent.antigravity.mcp_request_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				if (!response.headersSent) {
					writeJson(response, 500, {
						jsonrpc: "2.0",
						error: { code: -32_603, message: "Internal MCP server error" },
					});
				}
			});
		});
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", rejectListen);
				resolveListen();
			});
		});
		const address = server.address();
		if (address == null || typeof address === "string") {
			server.close();
			throw new Error("Local MCP server failed to bind an ephemeral TCP port");
		}
		this.#server = server;
		this.#port = address.port;
	}

	registerSession(input: {
		tools: readonly AgentTool[];
		getRunSignal: () => AbortSignal | undefined;
	}): McpSessionRegistration {
		if (this.#port === undefined) {
			throw new Error("Local MCP bridge is not started");
		}
		const routeId = randomBytes(16).toString("hex");
		const token = randomBytes(24).toString("hex");
		const tools = new Map<string, AgentTool>();
		for (const tool of input.tools) {
			if (tools.has(tool.name)) {
				throw new Error(`Duplicated agent tool name: ${tool.name}`);
			}
			tools.set(tool.name, tool);
		}
		this.#sessions.set(routeId, {
			token,
			tools,
			toolList: [...input.tools],
			getRunSignal: input.getRunSignal,
		});
		return {
			serverConfig: {
				type: "http",
				name: "luna",
				url: `http://127.0.0.1:${String(this.#port)}/mcp/${routeId}`,
				headers: [{ name: "authorization", value: `Bearer ${token}` }],
			},
			unregister: () => {
				this.#sessions.delete(routeId);
			},
		};
	}

	async close(): Promise<void> {
		this.#sessions.clear();
		const server = this.#server;
		this.#server = undefined;
		this.#port = undefined;
		if (server === undefined) return;
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => {
			server.close(() => {
				resolveClose();
			});
		});
	}

	async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") {
			response.writeHead(405, { allow: "POST" });
			response.end();
			return;
		}
		const routeId = extractRouteId(request.url);
		if (routeId === undefined) {
			response.writeHead(404);
			response.end();
			return;
		}
		const session = this.#sessions.get(routeId);
		if (session === undefined) {
			response.writeHead(404);
			response.end();
			return;
		}
		if (request.headers.authorization !== `Bearer ${session.token}`) {
			response.writeHead(401);
			response.end();
			return;
		}

		let rawBody: string;
		try {
			rawBody = await readBody(request);
		} catch (error: unknown) {
			writeJson(response, 400, {
				jsonrpc: "2.0",
				error: {
					code: -32_700,
					message: error instanceof Error ? error.message : "Failed to read request body",
				},
			});
			return;
		}

		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(rawBody);
		} catch {
			writeJson(response, 400, {
				jsonrpc: "2.0",
				error: { code: -32_700, message: "Invalid JSON" },
			});
			return;
		}
		const parsed = mcpRequestSchema.safeParse(parsedJson);
		if (!parsed.success) {
			writeJson(response, 400, {
				jsonrpc: "2.0",
				error: { code: -32_600, message: "Invalid JSON-RPC request" },
			});
			return;
		}

		const message = parsed.data;
		if (message.id === undefined) {
			// JSON-RPC 通知（notifications/initialized 等）は 202 で受理する。
			response.writeHead(202);
			response.end();
			return;
		}

		const { id, method, params } = message;
		switch (method) {
			case "initialize": {
				const init = mcpInitializeParamsSchema.safeParse(params ?? {});
				const protocolVersion =
					init.success && init.data.protocolVersion !== undefined
						? init.data.protocolVersion
						: DEFAULT_MCP_PROTOCOL_VERSION;
				writeJson(response, 200, {
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: "luna-mcp", version: "1.0.0" },
					},
				});
				return;
			}
			case "tools/list": {
				writeJson(response, 200, {
					jsonrpc: "2.0",
					id,
					result: {
						tools: session.toolList.map((tool) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: tool.parameters,
						})),
					},
				});
				return;
			}
			case "tools/call": {
				const call = mcpToolCallParamsSchema.safeParse(params);
				if (!call.success) {
					writeJson(response, 200, {
						jsonrpc: "2.0",
						id,
						error: {
							code: -32_602,
							message: `Invalid tool call params: ${z.prettifyError(call.error)}`,
						},
					});
					return;
				}
				const result = await this.#executeTool(
					session,
					call.data.name,
					call.data.arguments ?? {},
					request,
				);
				writeJson(response, 200, {
					jsonrpc: "2.0",
					id,
					result: toMcpToolResult(result),
				});
				return;
			}
			default: {
				writeJson(response, 200, {
					jsonrpc: "2.0",
					id,
					error: { code: -32_601, message: `Method not found: ${method}` },
				});
			}
		}
	}

	async #executeTool(
		session: RegisteredSession,
		name: string,
		argumentsValue: unknown,
		request: IncomingMessage,
	): Promise<AgentToolResult> {
		const tool = session.tools.get(name);
		if (tool === undefined) {
			return { text: `Unknown tool: ${name}`, images: [], isError: true };
		}
		const requestAbort = new AbortController();
		const onClose = () => {
			if (!request.complete) {
				requestAbort.abort(new Error("MCP client disconnected"));
			}
		};
		request.once("close", onClose);
		const runSignal = session.getRunSignal();
		const signal =
			runSignal === undefined
				? requestAbort.signal
				: AbortSignal.any([requestAbort.signal, runSignal]);
		try {
			return await tool.execute(argumentsValue, signal);
		} catch (error: unknown) {
			return {
				text: error instanceof Error ? error.message : String(error),
				images: [],
				isError: true,
			};
		} finally {
			request.off("close", onClose);
		}
	}
}

function extractRouteId(rawUrl: string | undefined): string | undefined {
	if (rawUrl === undefined) return undefined;
	const match = /^\/mcp\/([a-f0-9]+)$/u.exec(rawUrl);
	return match?.[1];
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
		totalBytes += buffer.length;
		if (totalBytes > MAX_BODY_BYTES) {
			throw new Error("MCP request body exceeds limit");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function toMcpToolResult(result: AgentToolResult): Readonly<{
	content: readonly (
		| Readonly<{ type: "text"; text: string }>
		| Readonly<{ type: "image"; data: string; mimeType: string }>
	)[];
	isError: boolean;
}> {
	const content: Array<
		| Readonly<{ type: "text"; text: string }>
		| Readonly<{ type: "image"; data: string; mimeType: string }>
	> = [];
	if (result.text !== "") {
		content.push({ type: "text", text: result.text });
	}
	for (const image of result.images) {
		content.push({ type: "image", data: image.data, mimeType: image.mimeType });
	}
	if (content.length === 0) {
		content.push({ type: "text", text: "" });
	}
	return { content, isError: result.isError };
}

function writeJson(
	response: ServerResponse,
	status: number,
	payload: Readonly<Record<string, unknown>>,
): void {
	const body = JSON.stringify(payload);
	response.writeHead(status, {
		"content-type": "application/json",
		"content-length": String(Buffer.byteLength(body)),
	});
	response.end(body);
}
