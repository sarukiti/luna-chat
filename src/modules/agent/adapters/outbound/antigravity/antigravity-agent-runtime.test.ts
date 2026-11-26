import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { formatLocalDate } from "../../../../../shared/local-date";
import { createRecordingLogger } from "../../../../observability/testing/recording-logger";
import { createActivityTable } from "../../../../tool/application/activity-table";
import type {
	AgentModel,
	AgentRuntimePort,
	AgentSession,
	AgentSessionSpec,
	AgentTool,
	ModelSelection,
} from "../../../ports/outbound/agent-session-port";
import { SessionBusyError, SessionClosedError } from "../pi/pi-agent-session";
import type { HarnessBackgroundListener } from "../pi/pi-agent-session";
import { AcpProcessError, AcpRpcError, AcpTimeoutError } from "./acp-client";
import type { AcpClientPort, AcpSessionNewInput } from "./acp-client";
import { extractAntigravityModels } from "./acp-protocol";
import type { AcpPromptResult, AcpSessionNewResult, AcpSessionUpdate } from "./acp-protocol";
import { AntigravityAcpRuntime } from "./antigravity-agent-runtime";
import { CompositeAgentRuntime } from "./composite-agent-runtime";

const NOW = new Date("2026-11-26T01:30:00+09:00");
const temporaryDirectories: string[] = [];
const runtimes: AntigravityAcpRuntime[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

const SAMPLE_SESSION_NEW: AcpSessionNewResult = {
	sessionId: "probe-session",
	models: {
		availableModels: [
			{ modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
			{ modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
			{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
			{ modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
			{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
			{ modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
			{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
		],
	},
	configOptions: [
		{
			id: "model",
			options: [
				{ value: "gemini-4-neon", name: "Gemini 4 Neon" },
				{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
				{ value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
			],
		},
		{
			id: "thought_level",
			options: [
				{ value: "low", name: "Low" },
				{ value: "medium", name: "Medium" },
				{ value: "high", name: "High" },
				{ value: "xhigh", name: "Extra" },
			],
		},
	],
};

type PromptHandler = (
	sessionId: string,
	text: string,
	emit: (update: AcpSessionUpdate) => void,
	options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
) => Promise<AcpPromptResult>;

class FakeAcpClient implements AcpClientPort {
	alive = true;
	readonly newSessionCalls: AcpSessionNewInput[] = [];
	readonly configCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
	readonly promptCalls: Array<{ sessionId: string; text: string }> = [];
	readonly cancelCalls: string[] = [];
	readonly closedSessions: string[] = [];
	readonly #listeners = new Map<string, Set<(update: AcpSessionUpdate) => void>>();
	#sessionCounter = 0;

	constructor(
		private readonly handlers: {
			onNewSession?: (input: AcpSessionNewInput) => Promise<AcpSessionNewResult>;
			onPrompt?: PromptHandler;
		} = {},
	) {}

	isAlive(): boolean {
		return this.alive;
	}

	async initialize() {
		return { protocolVersion: 1 };
	}

	async newSession(input: AcpSessionNewInput): Promise<AcpSessionNewResult> {
		this.newSessionCalls.push(input);
		if (this.handlers.onNewSession !== undefined) {
			return await this.handlers.onNewSession(input);
		}
		this.#sessionCounter += 1;
		return { ...SAMPLE_SESSION_NEW, sessionId: `acp-${String(this.#sessionCounter)}` };
	}

	async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
		this.configCalls.push({ sessionId, configId, value });
	}

	async prompt(
		sessionId: string,
		text: string,
		options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
	): Promise<AcpPromptResult> {
		this.promptCalls.push({ sessionId, text });
		const emit = (update: AcpSessionUpdate) => {
			for (const listener of this.#listeners.get(sessionId) ?? []) {
				listener(update);
			}
		};
		if (this.handlers.onPrompt !== undefined) {
			return await this.handlers.onPrompt(sessionId, text, emit, options);
		}
		emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "了解" } });
		return { stopReason: "end_turn" };
	}

	cancel(sessionId: string): void {
		this.cancelCalls.push(sessionId);
	}

	async closeSession(sessionId: string): Promise<void> {
		this.closedSessions.push(sessionId);
	}

	subscribe(sessionId: string, listener: (update: AcpSessionUpdate) => void): () => void {
		let set = this.#listeners.get(sessionId);
		if (set === undefined) {
			set = new Set();
			this.#listeners.set(sessionId, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	}

	async close(): Promise<void> {
		this.alive = false;
	}
}

async function setup(
	options: {
		clientFactory?: () => FakeAcpClient;
		retryDelaysMs?: number[];
		onSkillToolCall?: (name: string, args: unknown) => void;
	} = {},
) {
	const root = await mkdtemp(path.join(tmpdir(), "antigravity-runtime-test-"));
	temporaryDirectories.push(root);
	const createdClients: FakeAcpClient[] = [];
	const backgroundListeners: HarnessBackgroundListener[] = [];
	const backgroundCount = { value: 0 };
	const shellDispose = vi.fn(async () => undefined);

	const runtime = new AntigravityAcpRuntime({
		workspaceDir: root,
		geminiDir: path.join(root, "antigravity"),
		transcriptDir: path.join(root, "sessions"),
		scratchRoot: path.join(root, "scratch"),
		childEnvironment: {},
		retryDelaysMs: options.retryDelaysMs ?? [1, 1],
		requestTimeoutMs: 60_000,
		logger: createRecordingLogger(),
		now: () => NOW,
		onSkillToolCall: options.onSkillToolCall,
		createClient: () => {
			const client = options.clientFactory?.() ?? new FakeAcpClient();
			createdClients.push(client);
			return client;
		},
		createShellTools: ({ background }) => {
			backgroundListeners.push(background);
			const fakeExec: AgentTool = {
				name: "exec_command",
				description: "fake exec",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ text: "ok", images: [], isError: false }),
			};
			return {
				tools: [fakeExec],
				background: {
					count: () => backgroundCount.value,
					stopAll: async () => {
						backgroundCount.value = 0;
						background.stopped();
					},
				},
				dispose: shellDispose,
			};
		},
	});
	runtimes.push(runtime);
	await runtime.start();
	return {
		runtime,
		root,
		createdClients,
		backgroundListeners,
		backgroundCount,
		shellDispose,
	};
}

function sessionSpec(overrides: Partial<AgentSessionSpec> = {}): AgentSessionSpec {
	return {
		kind: "conversation",
		label: "テスト会話",
		cwd: "/workspace",
		systemPrompt: "あなたはルナです。",
		model: { provider: "antigravity", model: "gemini-3.8-flash", thinking: "low" },
		tools: [],
		harnessTools: ["exec_command"],
		fastMode: () => false,
		activities: createActivityTable(),
		...overrides,
	};
}

const transcriptLineSchema = z.looseObject({ type: z.string() });

async function readTranscript(root: string, sessionId: string) {
	const raw = await readFile(
		path.join(root, "sessions", formatLocalDate(NOW), `${sessionId}.jsonl`),
		"utf8",
	);
	return raw
		.trim()
		.split("\n")
		.map((line) => transcriptLineSchema.parse(JSON.parse(line)));
}

describe("extractAntigravityModels", () => {
	it("configOptions と availableModels から対応する thinking 一覧を抽出する", () => {
		expect(extractAntigravityModels(SAMPLE_SESSION_NEW)).toEqual([
			{
				provider: "antigravity",
				model: "gemini-4-neon",
				displayName: "Gemini 4 Neon",
				supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
			},
			{
				provider: "antigravity",
				model: "gemini-3.8-flash",
				displayName: "Gemini 3.8 Flash",
				supportedThinkingLevels: ["low", "medium", "high"],
			},
			{
				provider: "antigravity",
				model: "gpt-oss-120b-medium",
				displayName: "GPT-OSS 120B (Medium)",
				supportedThinkingLevels: ["medium"],
			},
		]);
	});
});

describe("AntigravityAcpRuntime と AntigravityAgentSession", () => {
	it("入力を luna_input で送り、応答本文・モデル設定・トランスクリプト・skill使用を記録する", async () => {
		const recordedSkills: Array<{ name: string; args: unknown }> = [];
		const client = new FakeAcpClient({
			onPrompt: async (_sid, _text, emit) => {
				emit({
					sessionUpdate: "tool_call",
					toolCallId: "t1",
					name: "read_file",
					args: { Path: ".agents/skills/cron/SKILL.md" },
					status: "completed",
				});
				emit({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "こんにちは" },
				});
				return { stopReason: "end_turn" };
			},
		});
		const { runtime, root } = await setup({
			clientFactory: () => client,
			onSkillToolCall: (name, args) => {
				recordedSkills.push({ name, args });
			},
		});

		const session = runtime.open(sessionSpec());
		const result = await session.run([{ kind: "discord_message", text: '{"msg":"やあ"}' }]);
		await session.close();

		expect(result).toEqual({ status: "completed", finalText: "こんにちは" });
		expect(client.promptCalls[0]?.text).toBe(
			'<luna_input kind="discord_message">\n{"msg":"やあ"}\n</luna_input>',
		);
		expect(client.configCalls).toEqual([
			{ sessionId: "acp-2", configId: "model", value: "gemini-3.8-flash" },
			{ sessionId: "acp-2", configId: "thought_level", value: "low" },
		]);
		expect(client.closedSessions).toEqual(["acp-1", "acp-2"]);
		expect(recordedSkills).toEqual([
			{ name: "read_file", args: { Path: ".agents/skills/cron/SKILL.md" } },
		]);

		const lines = await readTranscript(root, session.id);
		expect(lines.map((line) => line.type)).toEqual([
			"session_open",
			"message",
			"message",
			"message",
			"message",
		]);
		expect(lines[3]).toMatchObject({
			type: "message",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{
						type: "toolCall",
						id: "t1",
						name: "read_file",
						arguments: { Path: ".agents/skills/cron/SKILL.md" },
					},
				],
			},
		});
		expect(lines[4]).toMatchObject({
			type: "message",
			message: {
				role: "assistant",
				stopReason: "end_turn",
				content: [{ type: "text", text: "こんにちは" }],
			},
		});
	});

	it("MCPツール実行を pi 互換の assistant(toolCall)+toolResult で記録し、ACP側通知と二重記録しない", async () => {
		const recordedBuiltins: Array<{ name: string; args: unknown }> = [];
		const client = new FakeAcpClient({
			onPrompt: async (_sid, _text, emit) => {
				const mcpServer = client.newSessionCalls.at(-1)?.mcpServers[0];
				if (mcpServer === undefined) throw new Error("mcp server missing");
				// ACP 側からもプレフィックス付き通知が届くケースを再現する。
				emit({
					sessionUpdate: "tool_call",
					toolCallId: "acp-mcp-1",
					name: "mcp_luna_send_message",
					rawInput: { content: "おはよう" },
					status: "pending",
				});
				const response = await fetch(mcpServer.url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...Object.fromEntries(mcpServer.headers.map((header) => [header.name, header.value])),
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: {
							name: "send_message",
							arguments: { target: { kind: "channel", channelId: "1" }, content: "おはよう" },
						},
					}),
				});
				expect(response.status).toBe(200);
				emit({
					sessionUpdate: "tool_call_update",
					toolCallId: "acp-mcp-1",
					status: "completed",
					rawOutput: '{"messageId":"42"}',
				});
				// 組み込みツールは tool_call → tool_call_update の2段階で届くケースを再現する。
				emit({
					sessionUpdate: "tool_call",
					toolCallId: "builtin-1",
					name: "read_file",
					status: "pending",
				});
				emit({
					sessionUpdate: "tool_call_update",
					toolCallId: "builtin-1",
					rawInput: { Path: ".agents/skills/heartbeat/SKILL.md" },
					rawOutput: "# Heartbeat",
					status: "completed",
				});
				return { stopReason: "end_turn" };
			},
		});
		const { runtime, root } = await setup({
			clientFactory: () => client,
			onSkillToolCall: (name, args) => {
				recordedBuiltins.push({ name, args });
			},
		});

		const sendMessageTool: AgentTool = {
			name: "send_message",
			description: "send message",
			parameters: { type: "object", properties: { content: { type: "string" } } },
			execute: async () => ({ text: '{"messageId":"42"}', images: [], isError: false }),
		};
		const session = runtime.open(sessionSpec({ tools: [sendMessageTool] }));
		await session.run([{ kind: "discord_message", text: '{"msg":"hi"}' }]);
		await session.close();

		// 組み込みの read_file のみ1回だけ通知され、MCP の send_message は重複通知されない。
		expect(recordedBuiltins).toEqual([
			{ name: "read_file", args: { Path: ".agents/skills/heartbeat/SKILL.md" } },
		]);

		const lines = await readTranscript(root, session.id);
		const messages = lines
			.filter((line) => line.type === "message")
			.map((line) => z.looseObject({ role: z.string() }).parse(line["message"]));
		expect(messages.map((message) => message.role)).toEqual([
			"system",
			"luna_input",
			"assistant",
			"toolResult",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(messages[2]).toMatchObject({
			role: "assistant",
			stopReason: "toolUse",
			content: [
				{
					type: "toolCall",
					name: "send_message",
					arguments: { target: { kind: "channel", channelId: "1" }, content: "おはよう" },
				},
			],
		});
		expect(messages[3]).toMatchObject({
			role: "toolResult",
			toolName: "send_message",
			content: [{ type: "text", text: '{"messageId":"42"}' }],
			isError: false,
		});
		expect(messages[4]).toMatchObject({
			role: "assistant",
			stopReason: "toolUse",
			content: [
				{
					type: "toolCall",
					id: "builtin-1",
					name: "read_file",
					arguments: { Path: ".agents/skills/heartbeat/SKILL.md" },
				},
			],
		});
		expect(messages[5]).toMatchObject({
			role: "toolResult",
			toolCallId: "builtin-1",
			toolName: "read_file",
			content: [{ type: "text", text: "# Heartbeat" }],
			isError: false,
		});
	});

	it("実行中の run は SessionBusyError、閉じた後は SessionClosedError にする", async () => {
		const gate = Promise.withResolvers<void>();
		const client = new FakeAcpClient({
			onPrompt: async () => {
				await gate.promise;
				return { stopReason: "end_turn" };
			},
		});
		const { runtime } = await setup({ clientFactory: () => client });
		const session = runtime.open(sessionSpec());

		const running = session.run([{ kind: "discord_message", text: "1" }]);
		await expect(session.run([{ kind: "discord_message", text: "2" }])).rejects.toBeInstanceOf(
			SessionBusyError,
		);
		gate.resolve();
		await running;
		await session.close();
		await expect(session.run([{ kind: "discord_message", text: "3" }])).rejects.toBeInstanceOf(
			SessionClosedError,
		);
	});

	it("実行中の steer を並行 prompt として送り、アイドル時の steer は次の run の後ろに入れる", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let promptCount = 0;
		const client = new FakeAcpClient({
			onPrompt: async (_sid, text, emit) => {
				promptCount += 1;
				if (promptCount === 1) {
					firstStarted.resolve();
					await releaseFirst.promise;
					return { stopReason: "end_turn" };
				}
				emit({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `received:${text}` },
				});
				return { stopReason: "end_turn" };
			},
		});
		const { runtime } = await setup({ clientFactory: () => client });
		const session = runtime.open(sessionSpec());

		const running = session.run([{ kind: "discord_message", text: "first" }]);
		await firstStarted.promise;
		session.steer({ kind: "discord_message", text: "steered" });
		releaseFirst.resolve();

		await expect(running).resolves.toMatchObject({ status: "completed" });
		expect(client.promptCalls).toHaveLength(2);
		expect(client.promptCalls[1]?.text).toContain("steered");

		session.steer({ kind: "discord_message", text: "idle-steer" });
		await session.run([{ kind: "discord_message", text: "second" }]);
		expect(client.promptCalls[2]?.text).toBe(
			'<luna_input kind="discord_message">\nsecond\n</luna_input>\n\n<luna_input kind="discord_message">\nidle-steer\n</luna_input>',
		);
	});

	it("abort で session/cancel を送り aborted を返す", async () => {
		const started = Promise.withResolvers<void>();
		const client = new FakeAcpClient({
			onPrompt: async (_sid, _text, _emit, options) => {
				started.resolve();
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => {
						resolve();
					});
				});
				return { stopReason: "cancelled" };
			},
		});
		const { runtime } = await setup({ clientFactory: () => client });
		const session = runtime.open(sessionSpec());

		const running = session.run([{ kind: "discord_message", text: "cancel-me" }]);
		await started.promise;
		await session.abort();

		await expect(running).resolves.toEqual({ status: "aborted" });
		expect(client.cancelCalls).toEqual(["acp-2"]);
	});

	it("一時的な失敗は再試行し、プロセス切断時は再接続して復帰する", async () => {
		let attempt = 0;
		let clientIndex = 0;
		const { runtime, createdClients } = await setup({
			retryDelaysMs: [1, 1],
			clientFactory: () => {
				clientIndex += 1;
				const currentIndex = clientIndex;
				return new FakeAcpClient({
					onPrompt: async (_sid, _text, emit) => {
						attempt += 1;
						if (attempt === 1) {
							throw new AcpTimeoutError("timed out");
						}
						if (attempt === 2) {
							createdClients[currentIndex - 1]!.alive = false;
							throw new AcpProcessError("process crashed");
						}
						emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "復帰" } });
						return { stopReason: "end_turn" };
					},
				});
			},
		});

		const session = runtime.open(sessionSpec());
		const result = await session.run([{ kind: "discord_message", text: "retry" }]);

		expect(result).toEqual({ status: "completed", finalText: "復帰" });
		expect(session.status().retries).toBe(2);
		expect(createdClients).toHaveLength(2);
	});

	it("認証失敗・上限到達・致命的エラーは再試行せずに失敗を返し、認証状態へ反映する", async () => {
		let call = 0;
		const client = new FakeAcpClient({
			onPrompt: async () => {
				call += 1;
				if (call === 1) throw new AcpRpcError(-32_000, "Authentication required");
				if (call === 2) throw new AcpRpcError(-32_001, "429 RESOURCE_EXHAUSTED");
				if (call === 3) throw new AcpRpcError(-32_602, "Bad request");
				return { stopReason: "end_turn" };
			},
		});
		const { runtime } = await setup({ clientFactory: () => client });
		const session = runtime.open(sessionSpec());

		await expect(session.run([{ kind: "discord_message", text: "1" }])).resolves.toMatchObject({
			status: "failed",
			reason: "auth_required",
		});
		expect(runtime.status().auth).toBe("auth_required");

		await expect(session.run([{ kind: "discord_message", text: "2" }])).resolves.toMatchObject({
			status: "failed",
			reason: "usage_limit",
		});

		await expect(session.run([{ kind: "discord_message", text: "3" }])).resolves.toMatchObject({
			status: "failed",
			reason: "fatal",
		});

		await expect(session.run([{ kind: "discord_message", text: "4" }])).resolves.toMatchObject({
			status: "completed",
		});
		expect(runtime.status().auth).toBe("ready");
	});

	it("setModel で同一プロバイダのモデルを切り替え、別プロバイダへの変更は拒否する", async () => {
		const client = new FakeAcpClient();
		const { runtime } = await setup({ clientFactory: () => client });
		const session = runtime.open(sessionSpec());
		await session.run([{ kind: "discord_message", text: "hi" }]);

		session.setModel({ provider: "antigravity", model: "gemini-4-neon", thinking: "high" });
		await session.run([{ kind: "discord_message", text: "next" }]);

		expect(client.configCalls.slice(-2)).toEqual([
			{ sessionId: "acp-2", configId: "model", value: "gemini-4-neon" },
			{ sessionId: "acp-2", configId: "thought_level", value: "high" },
		]);
		expect(() =>
			session.setModel({ provider: "openai-codex", model: "gpt-6.2-sol", thinking: "medium" }),
		).toThrow("Cannot switch an open Antigravity session");
	});

	it("バックグラウンド実行の background_exit と SessionActivities の通知を待機・取り込みできる", async () => {
		const client = new FakeAcpClient();
		const { runtime, backgroundListeners, backgroundCount } = await setup({
			clientFactory: () => client,
		});
		const activities = createActivityTable();
		const session = runtime.open(sessionSpec({ activities }));
		await session.run([{ kind: "discord_message", text: "start" }]);

		backgroundCount.value = 1;
		expect(session.hasActivity()).toBe(true);
		const waiting = session.waitForActivity("any");
		backgroundCount.value = 0;
		backgroundListeners[0]?.exited({ kind: "background_exit", text: '{"id":"bg-1"}' });
		await expect(waiting).resolves.toBe("notice");

		await session.run([]);
		expect(client.promptCalls.at(-1)?.text).toBe(
			'<luna_input kind="background_exit">\n{"id":"bg-1"}\n</luna_input>',
		);

		const handle = activities.begin(async () => {});
		const urgentWait = session.waitForActivity("urgent");
		handle.notify({ kind: "minecraft_event", text: '{"n":1}' }, { urgent: false, replaceKey: "k" });
		handle.notify({ kind: "minecraft_event", text: '{"n":2}' }, { urgent: false, replaceKey: "k" });
		handle.notify({ kind: "minecraft_event", text: '{"n":3}' }, { urgent: true, replaceKey: "u" });
		await expect(urgentWait).resolves.toBe("urgent");
		await session.run([]);
		expect(client.promptCalls.at(-1)?.text).toBe(
			'<luna_input kind="minecraft_event">\n{"n":2}\n</luna_input>\n\n<luna_input kind="minecraft_event">\n{"n":3}\n</luna_input>',
		);
		await session.stopActivities();
		expect(session.hasActivity()).toBe(false);
	});
});

describe("CompositeAgentRuntime", () => {
	function stubRuntime(
		models: readonly AgentModel[],
		auth: "ready" | "auth_required" | "missing",
	): AgentRuntimePort & { opened: ModelSelection[] } {
		const opened: ModelSelection[] = [];
		return {
			opened,
			open(spec) {
				opened.push(spec.model);
				const session: AgentSession = {
					id: spec.model.provider,
					run: async () => ({ status: "completed", finalText: null }),
					steer: () => undefined,
					abort: async () => undefined,
					hasActivity: () => false,
					waitForActivity: async () => "none",
					stopActivities: async () => undefined,
					setModel: () => undefined,
					close: async () => undefined,
					status: () => ({
						id: spec.model.provider,
						kind: spec.kind,
						label: spec.label,
						model: spec.model,
						phase: "idle",
						phaseSince: NOW.toISOString(),
						retries: 0,
					}),
				};
				return session;
			},
			listModels: () => models,
			status: () => ({ auth, usage: null, lastFailure: null, sessions: [] }),
		};
	}

	it("provider に応じて pi と antigravity へ振り分け、認証状態とモデル一覧を統合する", () => {
		const pi = stubRuntime(
			[
				{
					provider: "openai-codex",
					model: "gpt-6.2-sol",
					displayName: "GPT-6.2 Sol",
					supportedThinkingLevels: ["medium"],
				},
			],
			"missing",
		);
		const agy = stubRuntime(
			[
				{
					provider: "antigravity",
					model: "gemini-4-neon",
					displayName: "Gemini 4 Neon",
					supportedThinkingLevels: ["high"],
				},
			],
			"ready",
		);
		const composite = new CompositeAgentRuntime({
			pi,
			antigravity: agy,
			preferAntigravityAuth: true,
		});

		composite.open(
			sessionSpec({
				model: { provider: "openai-codex", model: "gpt-6.2-sol", thinking: "medium" },
			}),
		);
		composite.open(
			sessionSpec({ model: { provider: "antigravity", model: "gemini-4-neon", thinking: "high" } }),
		);

		expect(pi.opened).toHaveLength(1);
		expect(agy.opened).toHaveLength(1);
		expect(composite.listModels().map((model) => `${model.provider}/${model.model}`)).toEqual([
			"openai-codex/gpt-6.2-sol",
			"antigravity/gemini-4-neon",
		]);
		expect(composite.status().auth).toBe("ready");
	});
});
