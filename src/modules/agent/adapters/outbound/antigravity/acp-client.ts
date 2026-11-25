import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import type { z } from "zod";

import type { LoggerPort } from "../../../../observability/ports/logger-port";
import {
	acpEmptyResultSchema,
	acpIncomingMessageSchema,
	acpInitializeResultSchema,
	acpPromptResultSchema,
	acpRequestPermissionParamsSchema,
	acpSessionNewResultSchema,
	acpSessionUpdateParamsSchema,
	acpSetConfigOptionResultSchema,
} from "./acp-protocol";
import type {
	AcpInitializeResult,
	AcpMcpServerConfig,
	AcpPromptResult,
	AcpSessionNewResult,
	AcpSessionUpdate,
} from "./acp-protocol";

const STDERR_TAIL_LIMIT = 16_384;
const CLOSE_GRACE_MS = 2_000;
const ACP_PROTOCOL_VERSION = 1;

export class AcpRpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "AcpRpcError";
	}
}

export class AcpTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AcpTimeoutError";
	}
}

export class AcpProcessError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AcpProcessError";
	}
}

export type AcpSessionNewInput = Readonly<{
	cwd: string;
	additionalDirectories?: readonly string[];
	mcpServers: readonly AcpMcpServerConfig[];
	systemPromptAppend?: string;
}>;

export type AcpClientPort = Readonly<{
	initialize(signal?: AbortSignal): Promise<AcpInitializeResult>;
	newSession(input: AcpSessionNewInput, signal?: AbortSignal): Promise<AcpSessionNewResult>;
	setConfigOption(
		sessionId: string,
		configId: string,
		value: string,
		signal?: AbortSignal,
	): Promise<void>;
	prompt(
		sessionId: string,
		text: string,
		options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
	): Promise<AcpPromptResult>;
	cancel(sessionId: string): void;
	closeSession(sessionId: string): Promise<void>;
	subscribe(sessionId: string, listener: (update: AcpSessionUpdate) => void): () => void;
	isAlive(): boolean;
	close(): Promise<void>;
}>;

export type StdioAcpClientOptions = Readonly<{
	command?: string;
	args?: readonly string[];
	cwd: string;
	geminiDir: string;
	env?: Readonly<Record<string, string | undefined>>;
	logger: LoggerPort;
}>;

type PendingRequest = Readonly<{
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}>;

export class StdioAcpClient implements AcpClientPort {
	readonly #child: ChildProcess;
	readonly #logger: LoggerPort;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #listeners = new Map<string, Set<(update: AcpSessionUpdate) => void>>();
	readonly #exited: Promise<void>;

	#nextId = 1;
	#closed = false;
	#exitError: Error | undefined;
	#stderr = "";

	constructor(options: StdioAcpClientOptions) {
		this.#logger = options.logger;
		const command = options.command ?? "agy";
		const args = options.args ?? [
			"acp",
			"--stdio",
			"--dangerously-skip-permissions",
			"--include-default-customizations=false",
			"--gemini-dir",
			options.geminiDir,
			"--app-data-dir",
			"antigravity-cli",
		];
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: buildChildEnv(options.env ?? process.env),
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child = child;
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_LIMIT);
		});
		child.stdin.on("error", () => undefined);

		const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
		reader.on("line", (line) => {
			this.#handleLine(line);
		});

		this.#exited = new Promise<void>((resolveExit) => {
			child.once("error", (error) => {
				this.#failAll(
					new AcpProcessError(`Failed to start Antigravity ACP (${command}): ${error.message}`, {
						cause: error,
					}),
				);
				resolveExit();
			});
			child.once("exit", (code, signal) => {
				const detail = this.#stderr.trim().slice(-500);
				const suffix = detail === "" ? "" : `: ${detail}`;
				const reason =
					code == null
						? `Antigravity ACP exited from signal ${signal ?? "unknown"}${suffix}`
						: `Antigravity ACP exited with code ${String(code)}${suffix}`;
				this.#failAll(new AcpProcessError(reason));
				resolveExit();
			});
		});
	}

	isAlive(): boolean {
		return !this.#closed && this.#exitError === undefined && this.#child.exitCode == null;
	}

	async initialize(signal?: AbortSignal): Promise<AcpInitializeResult> {
		return await this.#request(
			"initialize",
			{
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientCapabilities: {},
				clientInfo: { name: "luna-chat", version: "1.0.0" },
			},
			acpInitializeResultSchema,
			{ signal },
		);
	}

	async newSession(input: AcpSessionNewInput, signal?: AbortSignal): Promise<AcpSessionNewResult> {
		const params: Record<string, unknown> = {
			cwd: input.cwd,
			mcpServers: input.mcpServers,
		};
		if (input.additionalDirectories !== undefined && input.additionalDirectories.length > 0) {
			params["additionalDirectories"] = input.additionalDirectories;
		}
		if (input.systemPromptAppend !== undefined && input.systemPromptAppend !== "") {
			params["_meta"] = {
				antigravity: {
					systemPrompt: {
						append: input.systemPromptAppend,
					},
				},
			};
		}
		return await this.#request("session/new", params, acpSessionNewResultSchema, { signal });
	}

	async setConfigOption(
		sessionId: string,
		configId: string,
		value: string,
		signal?: AbortSignal,
	): Promise<void> {
		await this.#request(
			"session/set_config_option",
			{ sessionId, configId, value },
			acpSetConfigOptionResultSchema,
			{ signal },
		);
	}

	async prompt(
		sessionId: string,
		text: string,
		options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
	): Promise<AcpPromptResult> {
		return await this.#request(
			"session/prompt",
			{
				sessionId,
				prompt: [{ type: "text", text }],
			},
			acpPromptResultSchema,
			options,
		);
	}

	cancel(sessionId: string): void {
		if (!this.isAlive()) return;
		this.#write({
			jsonrpc: "2.0",
			method: "session/cancel",
			params: { sessionId },
		});
	}

	async closeSession(sessionId: string): Promise<void> {
		if (!this.isAlive()) return;
		await this.#request("session/close", { sessionId }, acpEmptyResultSchema, {
			timeoutMs: 10_000,
		});
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
			if (set.size === 0) {
				this.#listeners.delete(sessionId);
			}
		};
	}

	async close(): Promise<void> {
		if (this.#closed) {
			await this.#exited;
			return;
		}
		this.#closed = true;
		this.#failAll(new AcpProcessError("Antigravity ACP client closed"));
		try {
			this.#child.stdin?.end();
		} catch {
			// 終了済み
		}
		if (this.#child.exitCode == null && this.#child.pid !== undefined) {
			signalProcessGroup(this.#child, "SIGTERM");
			const timer = setTimeout(() => {
				if (this.#child.exitCode == null) {
					signalProcessGroup(this.#child, "SIGKILL");
				}
			}, CLOSE_GRACE_MS);
			timer.unref();
			try {
				await this.#exited;
			} finally {
				clearTimeout(timer);
			}
		} else {
			await this.#exited;
		}
	}

	async #request<T>(
		method: string,
		params: Readonly<Record<string, unknown>>,
		schema: z.ZodType<T>,
		options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		if (this.#exitError !== undefined) {
			throw this.#exitError;
		}
		const id = this.#nextId;
		this.#nextId += 1;

		const raw = await new Promise<unknown>((resolveRequest, rejectRequest) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const cleanup = () => {
				if (timer !== undefined) clearTimeout(timer);
				options?.signal?.removeEventListener("abort", onAbort);
				this.#pending.delete(id);
			};
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				fn();
			};
			const onAbort = () => {
				finish(() => {
					const reason: unknown = options?.signal?.reason;
					rejectRequest(
						reason instanceof Error ? reason : new Error(`Antigravity ACP ${method} aborted`),
					);
				});
			};
			if (options?.timeoutMs !== undefined) {
				timer = setTimeout(() => {
					finish(() => {
						rejectRequest(
							new AcpTimeoutError(
								`Antigravity ACP ${method} timed out after ${String(options.timeoutMs)}ms`,
							),
						);
					});
				}, options.timeoutMs);
			}
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			this.#pending.set(id, {
				resolve: (value) => {
					finish(() => {
						resolveRequest(value);
					});
				},
				reject: (error) => {
					finish(() => {
						rejectRequest(error);
					});
				},
			});
			try {
				this.#write({ jsonrpc: "2.0", id, method, params });
			} catch (error: unknown) {
				finish(() => {
					rejectRequest(error instanceof Error ? error : new Error(String(error)));
				});
			}
		});

		const parsed = schema.safeParse(raw);
		if (!parsed.success) {
			throw new AcpProcessError(
				`Antigravity ACP returned invalid ${method} response: ${parsed.error.message}`,
			);
		}
		return parsed.data;
	}

	#write(payload: Readonly<Record<string, unknown>>): void {
		const stdin = this.#child.stdin;
		if (stdin == null || !stdin.writable) {
			throw new AcpProcessError("Antigravity ACP stdin is not writable");
		}
		stdin.write(`${JSON.stringify(payload)}\n`);
	}

	#handleLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let raw: unknown;
		try {
			raw = JSON.parse(trimmed);
		} catch {
			this.#logger.warn("agent.antigravity.non_json_stdout", { line: trimmed.slice(0, 300) });
			return;
		}
		const parsed = acpIncomingMessageSchema.safeParse(raw);
		if (!parsed.success) {
			this.#logger.warn("agent.antigravity.invalid_message", { line: trimmed.slice(0, 300) });
			return;
		}
		const message = parsed.data;

		// 1. こちらが送ったリクエストへの応答
		if (
			typeof message.id === "number" &&
			message.method === undefined &&
			(message.result !== undefined || message.error !== undefined)
		) {
			const pending = this.#pending.get(message.id);
			if (pending === undefined) return;
			if (message.error !== undefined) {
				pending.reject(
					new AcpRpcError(message.error.code, message.error.message, message.error.data),
				);
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		// 2. サーバーからの通知
		if (message.method !== undefined && message.id === undefined) {
			if (message.method === "session/update") {
				const update = acpSessionUpdateParamsSchema.safeParse(message.params);
				if (update.success) {
					const listeners = this.#listeners.get(update.data.sessionId);
					if (listeners !== undefined) {
						for (const listener of listeners) {
							listener(update.data.update);
						}
					}
				}
			}
			return;
		}

		// 3. サーバーからのリクエスト（権限確認など）
		if (message.method !== undefined && message.id !== undefined) {
			if (message.method === "session/request_permission") {
				const permission = acpRequestPermissionParamsSchema.safeParse(message.params);
				const optionId = permission.success ? permission.data.options?.[0]?.optionId : undefined;
				this.#write({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						outcome: { outcome: "selected", optionId: optionId ?? "allow" },
					},
				});
				return;
			}
			this.#write({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32_601, message: `Method not found: ${message.method}` },
			});
		}
	}

	#failAll(error: Error): void {
		this.#exitError ??= error;
		for (const pending of this.#pending.values()) {
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

const AUTH_ERROR_PATTERN =
	/authentication required|unauthenticated|login required|oauth|invalid_grant|not logged in|\b401\b/iu;
const USAGE_LIMIT_PATTERN =
	/resource_exhausted|quota|rate.?limit|usage.?limit|too many requests|\b429\b/iu;
const TRANSIENT_ERROR_PATTERN =
	/timed out|timeout|unavailable|deadline exceeded|internal error|econnreset|epipe|socket hang up|\b50[0234]\b/iu;

export type AcpErrorKind = "usage_limit" | "auth_required" | "transient" | "fatal";

export function classifyAcpError(error: unknown): AcpErrorKind {
	if (error instanceof AcpTimeoutError) {
		return "transient";
	}
	const message = error instanceof Error ? error.message : String(error);
	if (
		(error instanceof AcpRpcError && error.code === -32_000) ||
		AUTH_ERROR_PATTERN.test(message)
	) {
		return "auth_required";
	}
	if (USAGE_LIMIT_PATTERN.test(message)) {
		return "usage_limit";
	}
	if (error instanceof AcpProcessError || TRANSIENT_ERROR_PATTERN.test(message)) {
		return "transient";
	}
	return "fatal";
}

export function isClientAlive(client: AcpClientPort | undefined): client is AcpClientPort {
	return client?.isAlive() ?? false;
}

function buildChildEnv(
	environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(environment)) {
		if (value !== undefined) {
			output[key] = value;
		}
	}
	return output;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// 終了済み
		}
	}
}
