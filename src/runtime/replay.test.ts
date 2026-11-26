import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import type {
	AcpClientPort,
	AcpSessionNewInput,
} from "../modules/agent/adapters/outbound/antigravity/acp-client";
import type {
	AcpPromptResult,
	AcpSessionNewResult,
	AcpSessionUpdate,
} from "../modules/agent/adapters/outbound/antigravity/acp-protocol";
import { ChatGptBackend } from "../modules/agent/adapters/outbound/pi/chatgpt-backend";
import type { WorkerCatalog } from "../modules/task/domain/task";
import { decideReplayPermission } from "./agent-runtime";
import { blindResults, parseReplayVariants, runReplay } from "./replay";
import type { ReplayResult } from "./replay";

const temporaryDirectories: string[] = [];
const REPLAY_WORKERS = {
	defaultName: "standard",
	choices: [
		{
			name: "standard",
			description: "x",
			exclusive: false,
			model: { provider: "faux", model: "faux-1", thinking: "off" },
		},
	],
} as const satisfies WorkerCatalog;

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (path) => await rm(path, { recursive: true, force: true })),
	);
});

describe("parseReplayVariants", () => {
	it("名前付きの指示の組を受け取り、ディレクトリ側の = は残す", () => {
		expect(parseReplayVariants(["current=/w", "proposed=/p=1"])).toEqual([
			{ name: "current", dir: "/w" },
			{ name: "proposed", dir: "/p=1" },
		]);
	});

	it.each([
		[[], "At least one variant"],
		[["=/w"], "<name>=<dir>"],
		[["a="], "<name>=<dir>"],
		[["a"], "<name>=<dir>"],
		[["a=/w", "a=/p"], "unique"],
	])("不正な引数 %j を拒否する", (values, message) => {
		expect(() => parseReplayVariants(values)).toThrow(message);
	});
});

describe("blindResults", () => {
	it("場面ごとに候補を並べ替えて A, B と名付け、対応を key に残す", () => {
		const results: ReplayResult[] = [
			{
				scene: "s1",
				variant: "current",
				status: "completed",
				calls: [{ tool: "x", arguments: 1 }],
			},
			{ scene: "s1", variant: "proposed", status: "completed", calls: [] },
		];
		const orders = [0.9, 0.1];

		const blind = blindResults(results, () => orders.shift() ?? 0);

		expect(blind).toEqual({
			candidates: [{ scene: "s1", candidates: { A: [], B: [{ tool: "x", arguments: 1 }] } }],
			key: { s1: { A: "proposed", B: "current" } },
		});
	});
});

describe("runReplay", () => {
	it("場面を指示の組ごとに再生し、外へ作用せずにツール呼び出しを記録する", async () => {
		const { faux, models, transcriptDir } = await setup();
		const prompts: string[] = [];
		const capture =
			(
				response: Parameters<typeof fauxAssistantMessage>[0],
				options?: Parameters<typeof fauxAssistantMessage>[1],
			): FauxResponseStep =>
			(context) => {
				const system = context.messages.find((message) => message.role === "system");
				prompts.push(typeof system?.content === "string" ? system.content : "");
				return fauxAssistantMessage(response, options);
			};
		faux.setResponses([
			capture(
				[
					fauxToolCall("exec_command", { cmd: "rm -rf /" }),
					fauxToolCall("send_message", {
						target: { kind: "channel", channelId: "200" },
						content: "やってみるね",
					}),
				],
				{ stopReason: "toolUse" },
			),
			capture([]),
			capture([]),
		]);

		const results = await runReplay({
			backend: new ChatGptBackend({ models, timeoutMs: 1_000 }),
			cwd: transcriptDir,
			model: { provider: "faux", model: "faux-1", thinking: "off" },
			models,
			requestTimeoutMs: 10_000,
			scenes: [{ id: "s1", inputs: [{ kind: "discord_message", text: "{}" }] }],
			scratchRoot: join(transcriptDir, "scratch"),
			transcriptDir,
			variants: [
				{ name: "current", systemPrompt: "OLD" },
				{ name: "proposed", systemPrompt: "NEW" },
			],
			workers: REPLAY_WORKERS,
		});

		expect(prompts).toEqual([
			expect.stringMatching(/^OLD\n\n# Scratch directory\n/u),
			expect.stringMatching(/^OLD\n\n# Scratch directory\n/u),
			expect.stringMatching(/^NEW\n\n# Scratch directory\n/u),
		]);
		expect(results).toEqual([
			{
				scene: "s1",
				variant: "current",
				status: "completed",
				calls: [
					{ tool: "exec_command", arguments: { cmd: "rm -rf /" } },
					{
						tool: "send_message",
						arguments: {
							kind: "send_message",
							target: { kind: "channel", channelId: "200" },
							content: "やってみるね",
						},
					},
				],
			},
			{ scene: "s1", variant: "proposed", status: "completed", calls: [] },
		]);
	});

	it("ツール呼び出しが上限に達したら打ち切る", async () => {
		const { faux, models, transcriptDir } = await setup();
		faux.setResponses(
			Array.from({ length: 20 }, () =>
				fauxAssistantMessage([fauxToolCall("edit", { path: "a" })], { stopReason: "toolUse" }),
			),
		);

		const [result] = await runReplay({
			backend: new ChatGptBackend({ models, timeoutMs: 1_000 }),
			cwd: transcriptDir,
			model: { provider: "faux", model: "faux-1", thinking: "off" },
			models,
			requestTimeoutMs: 10_000,
			scenes: [{ id: "s1", inputs: [{ kind: "discord_message", text: "{}" }] }],
			scratchRoot: join(transcriptDir, "scratch"),
			transcriptDir,
			variants: [{ name: "current", systemPrompt: "OLD" }],
			workers: REPLAY_WORKERS,
		});

		expect(result?.status).toBe("aborted");
		expect(result?.calls).toHaveLength(12);
	});

	it("antigravity モデルでも外へ作用せず MCP・スタブ・組み込みツールを記録し、上限で打ち切る", async () => {
		const { models, transcriptDir } = await setup();
		const newSessionInputs: AcpSessionNewInput[] = [];
		const closedClients: number[] = [];
		const clients = [
			createFakeReplayAcpClient({
				onNewSession: (input) => {
					newSessionInputs.push(input);
				},
				onPrompt: async (_sid, _text, emit, sessionInput) => {
					const mcp = sessionInput.mcpServers[0];
					if (mcp === undefined) throw new Error("missing mcp server");
					if (newSessionInputs.length === 2) {
						// 1番目のバリアント (current): スタブ exec_command、MCP send_message、組み込み read_file を呼ぶ
						await callMcpTool(mcp, "exec_command", { cmd: "rm -rf /" });
						await callMcpTool(mcp, "send_message", {
							target: { kind: "channel", channelId: "200" },
							content: "やってみるね",
						});
						emit({
							sessionUpdate: "tool_call",
							toolCallId: "r1",
							name: "read_file",
							rawInput: { Path: "LUNA.md" },
							status: "completed",
						});
					}
					return { stopReason: "end_turn" };
				},
				onClose: () => {
					closedClients.push(1);
				},
			}),
		];

		const results = await runReplay({
			backend: new ChatGptBackend({ models, timeoutMs: 1_000 }),
			cwd: transcriptDir,
			model: { provider: "antigravity", model: "gemini-3.8-flash", thinking: "low" },
			models,
			requestTimeoutMs: 10_000,
			scenes: [{ id: "s1", inputs: [{ kind: "discord_message", text: "{}" }] }],
			scratchRoot: join(transcriptDir, "scratch"),
			transcriptDir,
			variants: [
				{ name: "current", systemPrompt: "OLD" },
				{ name: "proposed", systemPrompt: "NEW" },
			],
			workers: REPLAY_WORKERS,
			antigravity: {
				geminiDir: join(transcriptDir, "antigravity"),
				childEnvironment: {},
				createClient: () => {
					const client = clients.shift();
					if (client === undefined) throw new Error("unexpected client creation");
					return client;
				},
			},
		});

		expect(closedClients).toEqual([1]);
		// probe + current + proposed = 3回 newSession
		expect(newSessionInputs).toHaveLength(3);
		expect(newSessionInputs[1]?.systemPromptAppend).toMatch(/^OLD\n\n# Scratch directory\n/u);
		expect(newSessionInputs[1]?.systemPromptAppend).toContain("This is a replay session.");
		expect(newSessionInputs[2]?.systemPromptAppend).toMatch(/^NEW\n\n# Scratch directory\n/u);
		expect(results).toEqual([
			{
				scene: "s1",
				variant: "current",
				status: "completed",
				calls: [
					{ tool: "exec_command", arguments: { cmd: "rm -rf /" } },
					{
						tool: "send_message",
						arguments: {
							kind: "send_message",
							target: { kind: "channel", channelId: "200" },
							content: "やってみるね",
						},
					},
					{ tool: "read_file", arguments: { Path: "LUNA.md" } },
				],
			},
			{ scene: "s1", variant: "proposed", status: "completed", calls: [] },
		]);

		// 上限12回で打ち切られることも確認する。
		const cancelCalls: string[] = [];
		const limitClient = createFakeReplayAcpClient({
			onPrompt: async (_sid, _text, _emit, sessionInput, options) => {
				const mcp = sessionInput.mcpServers[0];
				if (mcp === undefined) throw new Error("missing mcp server");
				for (let index = 0; index < 20; index += 1) {
					if (options?.signal?.aborted ?? false) {
						return { stopReason: "cancelled" };
					}
					await callMcpTool(mcp, "edit", { path: `file-${String(index)}` });
				}
				return { stopReason: "end_turn" };
			},
			onCancel: (sid) => {
				cancelCalls.push(sid);
			},
		});
		const [aborted] = await runReplay({
			backend: new ChatGptBackend({ models, timeoutMs: 1_000 }),
			cwd: transcriptDir,
			model: { provider: "antigravity", model: "gemini-3.8-flash", thinking: "low" },
			models,
			requestTimeoutMs: 10_000,
			scenes: [{ id: "s2", inputs: [{ kind: "discord_message", text: "{}" }] }],
			scratchRoot: join(transcriptDir, "scratch"),
			transcriptDir,
			variants: [{ name: "current", systemPrompt: "OLD" }],
			workers: REPLAY_WORKERS,
			antigravity: {
				geminiDir: join(transcriptDir, "antigravity"),
				childEnvironment: {},
				createClient: () => limitClient,
			},
		});
		expect(aborted?.status).toBe("aborted");
		expect(aborted?.calls).toHaveLength(12);
		expect(cancelCalls).toHaveLength(1);
	});
});

describe("decideReplayPermission", () => {
	const options = [
		{ optionId: "allow_once", kind: "allow_once" },
		{ optionId: "reject_once", kind: "reject_once" },
	] as const;
	const mcpTools = new Set(["send_message", "exec_command", "edit"]);

	it("読み取り系ツールと MCP ツールを許可する", () => {
		expect(
			decideReplayPermission(
				{ toolCall: { name: "read_file", kind: "read" }, options: [...options] },
				mcpTools,
			),
		).toEqual({ allowed: true, outcome: { outcome: "selected", optionId: "allow_once" } });
		expect(
			decideReplayPermission(
				{ toolCall: { name: "mcp_luna_edit", kind: "edit" }, options: [...options] },
				mcpTools,
			),
		).toEqual({ allowed: true, outcome: { outcome: "selected", optionId: "allow_once" } });
		expect(
			decideReplayPermission(
				{ toolCall: { name: "send_message", kind: "other" }, options: [...options] },
				mcpTools,
			),
		).toEqual({ allowed: true, outcome: { outcome: "selected", optionId: "allow_once" } });
	});

	it("組み込みの書き込み・削除・コマンド実行・未知ツールを fail-closed で拒否する", () => {
		expect(
			decideReplayPermission(
				{ toolCall: { name: "write_file", kind: "edit" }, options: [...options] },
				mcpTools,
			),
		).toEqual({ allowed: false, outcome: { outcome: "selected", optionId: "reject_once" } });
		expect(
			decideReplayPermission(
				{ toolCall: { name: "edit", kind: "edit" }, options: [...options] },
				mcpTools,
			),
		).toEqual({ allowed: false, outcome: { outcome: "selected", optionId: "reject_once" } });
		expect(
			decideReplayPermission(
				{ toolCall: { name: "run_command", kind: "execute" }, options: [...options] },
				mcpTools,
			),
		).toEqual({ allowed: false, outcome: { outcome: "selected", optionId: "reject_once" } });
		expect(
			decideReplayPermission(
				{ toolCall: { name: "image-generator" }, options: [{ optionId: "allow_once" }] },
				mcpTools,
			),
		).toEqual({ allowed: false, outcome: { outcome: "cancelled" } });
	});
});

async function callMcpTool(
	server: AcpSessionNewInput["mcpServers"][number],
	name: string,
	argumentsValue: Record<string, unknown>,
): Promise<void> {
	const response = await fetch(server.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: argumentsValue },
		}),
	});
	expect(response.status).toBe(200);
}

function createFakeReplayAcpClient(handlers: {
	onNewSession?: (input: AcpSessionNewInput) => void;
	onPrompt: (
		sessionId: string,
		text: string,
		emit: (update: AcpSessionUpdate) => void,
		sessionInput: AcpSessionNewInput,
		options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
	) => Promise<AcpPromptResult>;
	onCancel?: (sessionId: string) => void;
	onClose?: () => void;
}): AcpClientPort {
	let alive = true;
	let sessionCounter = 0;
	const sessions = new Map<string, AcpSessionNewInput>();
	const listeners = new Map<string, Set<(update: AcpSessionUpdate) => void>>();
	const catalog: AcpSessionNewResult = {
		sessionId: "probe",
		models: {
			availableModels: [{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }],
		},
		configOptions: [
			{ id: "model", options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }] },
			{ id: "thought_level", options: [{ value: "low", name: "Low" }] },
		],
	};
	return {
		isAlive: () => alive,
		initialize: async () => ({ protocolVersion: 1 }),
		newSession: async (input) => {
			handlers.onNewSession?.(input);
			sessionCounter += 1;
			const sessionId = `replay-acp-${String(sessionCounter)}`;
			sessions.set(sessionId, input);
			return { ...catalog, sessionId };
		},
		setConfigOption: async () => {},
		prompt: async (sessionId, text, options) => {
			const sessionInput = sessions.get(sessionId);
			if (sessionInput === undefined) throw new Error(`unknown session: ${sessionId}`);
			const emit = (update: AcpSessionUpdate) => {
				for (const listener of listeners.get(sessionId) ?? []) {
					listener(update);
				}
			};
			return await handlers.onPrompt(sessionId, text, emit, sessionInput, options);
		},
		cancel: (sessionId) => {
			handlers.onCancel?.(sessionId);
		},
		closeSession: async () => {},
		subscribe: (sessionId, listener) => {
			let set = listeners.get(sessionId);
			if (set === undefined) {
				set = new Set();
				listeners.set(sessionId, set);
			}
			set.add(listener);
			return () => {
				set.delete(listener);
			};
		},
		close: async () => {
			alive = false;
			handlers.onClose?.();
		},
	};
}

async function setup() {
	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux One" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const transcriptDir = await mkdtemp(join(tmpdir(), "luna-replay-test-"));
	temporaryDirectories.push(transcriptDir);
	return { faux, models, transcriptDir };
}
