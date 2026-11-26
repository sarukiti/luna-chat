import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import type { LoggerPort } from "../../../../observability/ports/logger-port";
import type {
	AgentModel,
	AgentRunFailureReason,
	AgentRuntimePort,
	AgentRuntimeStatus,
	AgentSession,
	AgentSessionSpec,
	AgentTool,
	HarnessToolName,
	ModelSelection,
} from "../../../ports/outbound/agent-session-port";
import type { HarnessBackground, HarnessBackgroundListener } from "../pi/pi-agent-session";
import { pruneTranscripts, TranscriptWriter, transcriptFilePath } from "../pi/pi-transcript";
import { createShellTools } from "../pi/shell-tools";
import { classifyAcpError, isClientAlive, StdioAcpClient } from "./acp-client";
import type { AcpClientPort, AcpPermissionOutcome } from "./acp-client";
import { ANTIGRAVITY_PROVIDER_ID, extractAntigravityModels } from "./acp-protocol";
import type { AcpRequestPermissionParams } from "./acp-protocol";
import { AntigravityAgentSession } from "./antigravity-agent-session";
import { LocalMcpBridge } from "./mcp-bridge";

const NO_BACKGROUND: HarnessBackground = { count: () => 0, stopAll: async () => {} };

const DEFAULT_ROUTING_INSTRUCTIONS =
	"For shell commands (especially run_in_background, which reports background_exit back to this session), use the MCP tools exec_command, write_stdin, and stop_background. For reading, editing, or writing workspace files, viewing images, web search, and image generation, use the built-in tools. For Discord, task management, HTTP responses, Home Assistant, and wait, always use the corresponding MCP tools.";

type AntigravityShellToolsFactory = (input: {
	cwd: string;
	scratchDir: string;
	background: HarnessBackgroundListener;
}) => Readonly<{
	tools: readonly AgentTool[];
	background: HarnessBackground;
	dispose(): Promise<void>;
}>;

type AntigravityPermissionContext = Readonly<{
	mcpToolNames: ReadonlySet<string>;
}>;

export type AntigravityAcpRuntimeOptions = Readonly<{
	workspaceDir: string;
	geminiDir: string;
	transcriptDir: string;
	scratchRoot: string;
	childEnvironment: Readonly<Record<string, string | undefined>>;
	retryDelaysMs: readonly number[];
	requestTimeoutMs: number;
	logger: LoggerPort;
	now(): Date;
	dangerouslySkipPermissions?: boolean;
	onPermissionRequest?: (
		params: AcpRequestPermissionParams,
		context: AntigravityPermissionContext,
	) => AcpPermissionOutcome;
	routingInstructions?: string;
	onSkillToolCall?: (name: string, args: unknown) => void;
	onBuiltinToolCall?: (name: string, args: unknown) => void;
	createClient?: (input: { cwd: string; geminiDir: string }) => AcpClientPort;
	createShellTools?: AntigravityShellToolsFactory;
}>;

export class AntigravityAcpRuntime implements AgentRuntimePort {
	readonly #options: AntigravityAcpRuntimeOptions;
	readonly #mcpBridge: LocalMcpBridge;
	readonly #sessions = new Map<string, AntigravityAgentSession>();
	readonly #sessionMcpTools = new Map<string, ReadonlySet<string>>();

	#authFailed = false;
	#client: AcpClientPort | undefined;
	#connecting: Promise<AcpClientPort> | undefined;
	#lastFailure: { at: string; message: string } | null = null;
	#models: readonly AgentModel[] = [];
	#started = false;

	constructor(options: AntigravityAcpRuntimeOptions) {
		this.#options = options;
		this.#mcpBridge = new LocalMcpBridge(options.logger);
	}

	async start(signal?: AbortSignal): Promise<void> {
		if (this.#started) return;
		await this.#mcpBridge.start();
		try {
			const client = await this.#ensureClient(signal);
			const probe = await client.newSession(
				{
					cwd: this.#options.workspaceDir,
					mcpServers: [],
				},
				signal,
			);
			this.#models = extractAntigravityModels(probe);
			await client.closeSession(probe.sessionId).catch((error: unknown) => {
				this.#options.logger.warn("agent.antigravity.probe_close_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			this.#authFailed = false;
			this.#started = true;
		} catch (error: unknown) {
			if (classifyAcpError(error) === "auth_required") {
				this.#authFailed = true;
			}
			await this.close();
			throw error;
		}
	}

	open(spec: AgentSessionSpec): AgentSession {
		if (!this.#started) {
			throw new Error("Antigravity ACP runtime is not started");
		}
		this.#validateModel(spec.model);
		const id = randomUUID();
		const scratchDir = path.join(this.#options.scratchRoot, id);
		mkdirSync(scratchDir, { recursive: true, mode: 0o700 });

		const wanted = new Set<HarnessToolName>(spec.harnessTools);
		const wantsHarness =
			this.#options.createShellTools !== undefined ||
			wanted.has("exec_command") ||
			wanted.has("write_stdin") ||
			wanted.has("stop_background");

		let opened: AntigravityAgentSession | undefined;
		const shell = wantsHarness
			? this.#createShellTools({
					cwd: spec.cwd,
					scratchDir,
					background: {
						exited: (message) =>
							opened?.onActivityNotice({ message, urgent: false, replaceKey: null }),
						stopped: () => opened?.onActivityStopped(),
					},
				})
			: undefined;

		const shellTools = (shell?.tools ?? [])
			.filter((tool) => isHarnessToolName(tool.name) && wanted.has(tool.name))
			.map((tool) =>
				tool.name === "exec_command" ? observeToolCall(tool, this.#options.onSkillToolCall) : tool,
			);
		const allMcpTools = [...spec.tools, ...shellTools];
		const mcpToolNames = new Set(allMcpTools.map((tool) => tool.name));

		let getRunSignal: () => AbortSignal | undefined = () => undefined;
		let registration: ReturnType<LocalMcpBridge["registerSession"]>;
		try {
			registration = this.#mcpBridge.registerSession({
				tools: allMcpTools,
				getRunSignal: () => getRunSignal(),
				onToolExecuted: (record) => {
					opened?.onMcpToolExecuted(record);
				},
			});
		} catch (error: unknown) {
			void shell?.dispose().catch((disposeError: unknown) => {
				this.#options.logger.error("agent.antigravity.shell_dispose_failed", {
					error: disposeError instanceof Error ? disposeError.message : String(disposeError),
				});
			});
			throw error;
		}

		const systemPromptAppend = buildAntigravitySystemPrompt(
			spec.systemPrompt,
			scratchDir,
			this.#options.routingInstructions ?? DEFAULT_ROUTING_INSTRUCTIONS,
		);
		const session = new AntigravityAgentSession({
			id,
			spec,
			scratchDir,
			systemPromptAppend,
			mcpServer: registration.serverConfig,
			mcpToolNames,
			unregisterMcp: registration.unregister,
			bindRunSignal: (getter) => {
				getRunSignal = getter;
			},
			getClient: () => this.#ensureClient(),
			validateModel: (selection) => {
				this.#validateModel(selection);
			},
			background: shell?.background ?? NO_BACKGROUND,
			disposeShell: async () => {
				await shell?.dispose();
			},
			retryDelaysMs: this.#options.retryDelaysMs,
			requestTimeoutMs: this.#options.requestTimeoutMs,
			transcript: new TranscriptWriter({
				filePath: transcriptFilePath(this.#options.transcriptDir, this.#options.now(), id),
				logger: this.#options.logger,
				sessionId: id,
			}),
			logger: this.#options.logger,
			now: this.#options.now,
			onToolCall: (name, args) => {
				this.#options.onSkillToolCall?.(name, args);
				this.#options.onBuiltinToolCall?.(name, args);
			},
			onRunCompleted: () => {
				this.#authFailed = false;
			},
			onRunFailed: (reason, message) => {
				this.#recordFailure(reason, message);
			},
			onClosed: (sessionId) => {
				this.#sessions.delete(sessionId);
				this.#sessionMcpTools.delete(sessionId);
			},
		});
		opened = session;
		this.#sessions.set(id, session);
		this.#sessionMcpTools.set(id, mcpToolNames);
		return session;
	}

	listModels(): readonly AgentModel[] {
		return this.#models;
	}

	status(): AgentRuntimeStatus {
		return {
			auth: !this.#started ? "missing" : this.#authFailed ? "auth_required" : "ready",
			usage: null,
			lastFailure: this.#lastFailure,
			sessions: [...this.#sessions.values()].map((session) => session.status()),
		};
	}

	pruneTranscripts(now: Date, retentionMs: number): Promise<number> {
		return pruneTranscripts(this.#options.transcriptDir, now, retentionMs);
	}

	async close(): Promise<void> {
		this.#started = false;
		const openSessions = [...this.#sessions.values()];
		await Promise.allSettled(openSessions.map((session) => session.close()));
		const client = this.#client;
		this.#client = undefined;
		this.#connecting = undefined;
		await client?.close();
		await this.#mcpBridge.close();
	}

	async #ensureClient(signal?: AbortSignal): Promise<AcpClientPort> {
		const existing = this.#client;
		if (isClientAlive(existing)) {
			return existing;
		}
		if (this.#connecting !== undefined) {
			return await this.#connecting;
		}
		const connecting = (async () => {
			const previous = this.#client;
			this.#client = undefined;
			await previous?.close();
			const next =
				this.#options.createClient?.({
					cwd: this.#options.workspaceDir,
					geminiDir: this.#options.geminiDir,
				}) ??
				new StdioAcpClient({
					cwd: this.#options.workspaceDir,
					geminiDir: this.#options.geminiDir,
					env: this.#options.childEnvironment,
					dangerouslySkipPermissions: this.#options.dangerouslySkipPermissions,
					onPermissionRequest:
						this.#options.onPermissionRequest === undefined
							? undefined
							: (params) =>
									this.#options.onPermissionRequest!(params, {
										mcpToolNames: this.#allMcpToolNames(),
									}),
					logger: this.#options.logger,
				});
			try {
				await next.initialize(signal);
			} catch (error: unknown) {
				await next.close();
				throw error;
			}
			this.#client = next;
			return next;
		})();
		this.#connecting = connecting;
		try {
			return await connecting;
		} finally {
			if (this.#connecting === connecting) {
				this.#connecting = undefined;
			}
		}
	}

	#createShellTools(input: {
		cwd: string;
		scratchDir: string;
		background: HarnessBackgroundListener;
	}) {
		if (this.#options.createShellTools !== undefined) {
			return this.#options.createShellTools(input);
		}
		return createShellTools({
			cwd: input.cwd,
			env: { ...this.#options.childEnvironment, TMPDIR: input.scratchDir },
			scratchDir: input.scratchDir,
			background: input.background,
		});
	}

	#validateModel(selection: ModelSelection): void {
		if (selection.provider !== ANTIGRAVITY_PROVIDER_ID) {
			throw new Error(`Unknown model: ${selection.provider}/${selection.model}`);
		}
		const model = this.#models.find((candidate) => candidate.model === selection.model);
		if (model === undefined) {
			throw new Error(`Unknown model: ${selection.provider}/${selection.model}`);
		}
		if (!model.supportedThinkingLevels.includes(selection.thinking)) {
			throw new Error(
				`${selection.provider}/${selection.model} does not support thinking ${selection.thinking}`,
			);
		}
	}

	#allMcpToolNames(): ReadonlySet<string> {
		const names = new Set<string>();
		for (const set of this.#sessionMcpTools.values()) {
			for (const name of set) {
				names.add(name);
			}
		}
		return names;
	}

	#recordFailure(reason: AgentRunFailureReason, message: string): void {
		this.#lastFailure = { at: this.#options.now().toISOString(), message };
		if (reason === "auth_required") {
			this.#authFailed = true;
		}
	}
}

function buildAntigravitySystemPrompt(
	systemPrompt: string,
	scratchDir: string,
	routingInstructions: string,
): string {
	return [
		systemPrompt,
		`# Scratch directory\n\nThis session's scratch directory is ${scratchDir}. exec_command sets it as TMPDIR.`,
		`# Antigravity tool routing\n\n${routingInstructions}`,
	].join("\n\n");
}

function isHarnessToolName(name: string): name is HarnessToolName {
	return (
		name === "exec_command" ||
		name === "write_stdin" ||
		name === "stop_background" ||
		name === "read" ||
		name === "edit" ||
		name === "write" ||
		name === "view_image" ||
		name === "web_run" ||
		name === "image_gen"
	);
}

function observeToolCall(
	tool: AgentTool,
	onToolCall: ((name: string, args: unknown) => void) | undefined,
): AgentTool {
	if (onToolCall === undefined) return tool;
	return {
		...tool,
		execute: async (argumentsValue, signal) => {
			onToolCall(tool.name, argumentsValue);
			return await tool.execute(argumentsValue, signal);
		},
	};
}
