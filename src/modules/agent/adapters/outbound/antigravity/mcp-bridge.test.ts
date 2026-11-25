import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createRecordingLogger } from "../../../../observability/testing/recording-logger";
import type { AgentTool } from "../../../ports/outbound/agent-session-port";
import { LocalMcpBridge } from "./mcp-bridge";
import type { McpToolExecutionRecord } from "./mcp-bridge";

const bridges: LocalMcpBridge[] = [];

afterEach(async () => {
	await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

async function createBridge(): Promise<LocalMcpBridge> {
	const bridge = new LocalMcpBridge(createRecordingLogger());
	await bridge.start();
	bridges.push(bridge);
	return bridge;
}

const jsonRpcSchema = z.looseObject({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.number(), z.string()]).optional(),
	result: z.unknown().optional(),
	error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});

async function postJson(
	url: string,
	headers: readonly Readonly<{ name: string; value: string }>[],
	body: unknown,
): Promise<{ status: number; json: unknown }> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...Object.fromEntries(headers.map((header) => [header.name, header.value])),
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const text = await response.text();
	return { status: response.status, json: text === "" ? undefined : JSON.parse(text) };
}

describe("LocalMcpBridge", () => {
	it("initialize・tools/list・tools/call（テキスト/画像/isError/例外）を処理する", async () => {
		const bridge = await createBridge();
		const received: unknown[] = [];
		const tools: AgentTool[] = [
			{
				name: "ok_tool",
				description: "returns text and image",
				parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
				execute: async (args) => {
					received.push(args);
					return {
						text: "完了",
						images: [{ data: "aW1n", mimeType: "image/png" }],
						isError: false,
					};
				},
			},
			{
				name: "failing_tool",
				description: "returns isError",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ text: "だめ", images: [], isError: true }),
			},
			{
				name: "throwing_tool",
				description: "throws",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					throw new Error("内部例外");
				},
			},
		];
		const registration = bridge.registerSession({
			tools,
			getRunSignal: () => undefined,
		});
		const { url, headers } = registration.serverConfig;

		const init = await postJson(url, headers, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-11-25" },
		});
		expect(init.status).toBe(200);
		expect(jsonRpcSchema.parse(init.json).result).toMatchObject({
			protocolVersion: "2025-11-25",
			capabilities: { tools: {} },
		});

		const notify = await postJson(url, headers, {
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		expect(notify.status).toBe(202);

		const list = await postJson(url, headers, { jsonrpc: "2.0", id: 2, method: "tools/list" });
		expect(jsonRpcSchema.parse(list.json).result).toEqual({
			tools: [
				{
					name: "ok_tool",
					description: "returns text and image",
					inputSchema: {
						type: "object",
						properties: { msg: { type: "string" } },
						required: ["msg"],
					},
				},
				{
					name: "failing_tool",
					description: "returns isError",
					inputSchema: { type: "object", properties: {} },
				},
				{
					name: "throwing_tool",
					description: "throws",
					inputSchema: { type: "object", properties: {} },
				},
			],
		});

		const okCall = await postJson(url, headers, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "ok_tool", arguments: { msg: "hi" } },
		});
		expect(received).toEqual([{ msg: "hi" }]);
		expect(jsonRpcSchema.parse(okCall.json).result).toEqual({
			content: [
				{ type: "text", text: "完了" },
				{ type: "image", data: "aW1n", mimeType: "image/png" },
			],
			isError: false,
		});

		const failCall = await postJson(url, headers, {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "failing_tool", arguments: {} },
		});
		expect(jsonRpcSchema.parse(failCall.json).result).toEqual({
			content: [{ type: "text", text: "だめ" }],
			isError: true,
		});

		const throwCall = await postJson(url, headers, {
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: { name: "throwing_tool", arguments: {} },
		});
		expect(jsonRpcSchema.parse(throwCall.json).result).toEqual({
			content: [{ type: "text", text: "内部例外" }],
			isError: true,
		});

		const unknownCall = await postJson(url, headers, {
			jsonrpc: "2.0",
			id: 6,
			method: "tools/call",
			params: { name: "missing", arguments: {} },
		});
		expect(jsonRpcSchema.parse(unknownCall.json).result).toEqual({
			content: [{ type: "text", text: "Unknown tool: missing" }],
			isError: true,
		});
	});

	it("認証失敗・不正メソッド・不正JSON・登録解除後ルートを拒否する", async () => {
		const bridge = await createBridge();
		const registration = bridge.registerSession({
			tools: [],
			getRunSignal: () => undefined,
		});
		const { url, headers } = registration.serverConfig;

		const getResponse = await fetch(url, { method: "GET" });
		expect(getResponse.status).toBe(405);

		const unauthorized = await postJson(url, [], { jsonrpc: "2.0", id: 1, method: "tools/list" });
		expect(unauthorized.status).toBe(401);

		const invalidJson = await postJson(url, headers, "{not-json");
		expect(invalidJson.status).toBe(400);

		const unknownMethod = await postJson(url, headers, {
			jsonrpc: "2.0",
			id: 2,
			method: "server/discover",
		});
		expect(unknownMethod.status).toBe(200);
		expect(jsonRpcSchema.parse(unknownMethod.json).error?.code).toBe(-32_601);

		registration.unregister();
		const gone = await postJson(url, headers, { jsonrpc: "2.0", id: 3, method: "tools/list" });
		expect(gone.status).toBe(404);
	});

	it("実行中の runSignal が abort されるとツール側の AbortSignal にも伝播する", async () => {
		const bridge = await createBridge();
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const registration = bridge.registerSession({
			tools: [
				{
					name: "wait_tool",
					description: "waits for abort",
					parameters: { type: "object", properties: {} },
					execute: async (_args, signal) => {
						started.resolve();
						await new Promise<void>((resolve) => {
							signal.addEventListener("abort", () => {
								resolve();
							});
						});
						return { text: "aborted", images: [], isError: true };
					},
				},
			],
			getRunSignal: () => controller.signal,
		});

		const call = postJson(registration.serverConfig.url, registration.serverConfig.headers, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "wait_tool", arguments: {} },
		});
		await started.promise;
		controller.abort(new Error("stop"));

		const response = await call;
		expect(jsonRpcSchema.parse(response.json).result).toEqual({
			content: [{ type: "text", text: "aborted" }],
			isError: true,
		});
	});

	it("重複したツール名の登録を拒否する", async () => {
		const bridge = await createBridge();
		const tool: AgentTool = {
			name: "dup",
			description: "dup",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ text: "", images: [], isError: false }),
		};
		expect(() =>
			bridge.registerSession({ tools: [tool, tool], getRunSignal: () => undefined }),
		).toThrow("Duplicated agent tool name: dup");
	});

	it("tools/call の結果を onToolExecuted で通知する", async () => {
		const bridge = await createBridge();
		const executed: McpToolExecutionRecord[] = [];
		const registration = bridge.registerSession({
			tools: [
				{
					name: "send_message",
					description: "send",
					parameters: { type: "object", properties: { content: { type: "string" } } },
					execute: async () => ({ text: '{"messageId":"1"}', images: [], isError: false }),
				},
			],
			getRunSignal: () => undefined,
			onToolExecuted: (record) => {
				executed.push(record);
			},
		});
		const { url, headers } = registration.serverConfig;

		await postJson(url, headers, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "send_message", arguments: { content: "やあ" } },
		});
		await postJson(url, headers, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "unknown_tool", arguments: {} },
		});

		expect(executed).toEqual([
			{
				toolCallId: expect.stringMatching(/^mcp-/u),
				name: "send_message",
				arguments: { content: "やあ" },
				result: { text: '{"messageId":"1"}', images: [], isError: false },
			},
			{
				toolCallId: expect.stringMatching(/^mcp-/u),
				name: "unknown_tool",
				arguments: {},
				result: { text: "Unknown tool: unknown_tool", images: [], isError: true },
			},
		]);
	});
});
