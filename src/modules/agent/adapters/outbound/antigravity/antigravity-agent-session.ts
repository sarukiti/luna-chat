import type { LoggerPort } from "../../../../observability/ports/logger-port";
import type {
	ActivityNotice,
	ActivityWaitFilter,
	ActivityWakeup,
	AgentInputMessage,
	AgentRunFailureReason,
	AgentRunResult,
	AgentSession,
	AgentSessionPhase,
	AgentSessionSpec,
	AgentSessionStatus,
	ModelSelection,
} from "../../../ports/outbound/agent-session-port";
import { formatLunaInput } from "../pi/luna-input-message";
import { SessionBusyError, SessionClosedError } from "../pi/pi-agent-session";
import type { HarnessBackground } from "../pi/pi-agent-session";
import type { TranscriptWriter } from "../pi/pi-transcript";
import { AcpProcessError, AcpTimeoutError, classifyAcpError, isClientAlive } from "./acp-client";
import type { AcpClientPort } from "./acp-client";
import { ANTIGRAVITY_PROVIDER_ID } from "./acp-protocol";
import type { AcpMcpServerConfig, AcpSessionUpdate } from "./acp-protocol";

export type AntigravityAgentSessionInput = Readonly<{
	id: string;
	spec: AgentSessionSpec;
	scratchDir: string;
	systemPromptAppend: string;
	mcpServer: AcpMcpServerConfig;
	unregisterMcp(): void;
	bindRunSignal(getter: () => AbortSignal | undefined): void;
	getClient(): Promise<AcpClientPort>;
	validateModel(selection: ModelSelection): void;
	background: HarnessBackground;
	disposeShell(): Promise<void>;
	retryDelaysMs: readonly number[];
	requestTimeoutMs: number;
	transcript: TranscriptWriter;
	logger: LoggerPort;
	now(): Date;
	onToolCall?: (name: string, args: unknown) => void;
	onRunCompleted(): void;
	onRunFailed(reason: AgentRunFailureReason, message: string): void;
	onClosed(sessionId: string): void;
}>;

export class AntigravityAgentSession implements AgentSession {
	readonly id: string;
	readonly #input: AntigravityAgentSessionInput;
	readonly #logger: LoggerPort;
	readonly #spec: AgentSessionSpec;
	readonly #transcript: TranscriptWriter;

	#abortController: AbortController | undefined;
	#abortRequested = false;
	#activityWaiters: Array<{
		filter: ActivityWaitFilter;
		resolve: (wakeup: ActivityWakeup) => void;
	}> = [];
	#activeClient: AcpClientPort | undefined;
	#closed = false;
	#inFlightSteers: Promise<unknown>[] = [];
	#modelDirty = false;
	#modelSelection: ModelSelection;
	#pendingNotices: ActivityNotice[] = [];
	#pendingSteers: AgentInputMessage[] = [];
	#phase: AgentSessionPhase = "idle";
	#phaseSince: string;
	#remoteSessionId: string | undefined;
	#retries = 0;
	#retryWait: { cancel(): void } | undefined;
	#runSettled: Promise<void> | undefined;
	#running = false;
	#turnText = "";
	#unsubscribe: (() => void) | undefined;

	constructor(input: AntigravityAgentSessionInput) {
		this.id = input.id;
		this.#input = input;
		this.#logger = input.logger;
		this.#spec = input.spec;
		this.#transcript = input.transcript;
		this.#modelSelection = input.spec.model;
		this.#phaseSince = input.now().toISOString();

		input.bindRunSignal(() => this.#abortController?.signal);
		input.spec.activities.connect({
			notify: (notice) => {
				this.onActivityNotice(notice);
			},
			stopped: () => {
				this.onActivityStopped();
			},
		});

		this.#transcript.append({
			type: "session_open",
			at: this.#phaseSince,
			sessionId: this.id,
			kind: input.spec.kind,
			label: input.spec.label,
			model: input.spec.model,
		});
		this.#transcript.append({
			type: "message",
			at: this.#phaseSince,
			message: { role: "system", content: input.systemPromptAppend },
		});
	}

	async run(messages: readonly AgentInputMessage[]): Promise<AgentRunResult> {
		this.#assertOpen();
		if (this.#running) {
			throw new SessionBusyError(this.id);
		}
		const input = [
			...this.#pendingNotices.map((notice) => notice.message),
			...messages,
			...this.#pendingSteers,
		];
		if (input.length === 0) {
			throw new Error(`Agent run requires input: ${this.id}`);
		}
		this.#pendingNotices = [];
		this.#pendingSteers = [];
		this.#running = true;
		const settled = Promise.withResolvers<void>();
		this.#runSettled = settled.promise;
		try {
			return await this.#execute(input);
		} finally {
			this.#running = false;
			this.#abortController = undefined;
			if (!this.#closed) {
				this.#setPhase("idle");
			}
			settled.resolve();
		}
	}

	steer(message: AgentInputMessage): void {
		this.#assertOpen();
		const activeClient = this.#activeClient;
		if (
			this.#running &&
			this.#phase === "running" &&
			this.#remoteSessionId !== undefined &&
			isClientAlive(activeClient)
		) {
			this.#recordLunaInputs([message]);
			const signal = this.#abortController?.signal;
			const steerPromise = activeClient.prompt(this.#remoteSessionId, formatLunaInput(message), {
				signal,
				timeoutMs: this.#input.requestTimeoutMs,
			});
			// 未処理の rejection を防ぐため即座に catch を付け、本体の待機ループで結果を検証する。
			void steerPromise.catch(() => undefined);
			this.#inFlightSteers.push(steerPromise);
			return;
		}
		this.#pendingSteers.push(message);
	}

	hasActivity(): boolean {
		return this.#pendingNotices.length > 0 || this.#activityCount() > 0;
	}

	waitForActivity(filter: ActivityWaitFilter): Promise<ActivityWakeup> {
		const pending = wakeupFor(this.#pendingNotices, filter);
		if (pending !== "none") {
			return Promise.resolve(pending);
		}
		if (this.#closed || this.#activityCount() === 0) {
			return Promise.resolve("none");
		}
		return new Promise((resolve) => {
			this.#activityWaiters.push({ filter, resolve });
		});
	}

	async stopActivities(): Promise<void> {
		this.#pendingNotices = [];
		await Promise.all([this.#input.background.stopAll(), this.#spec.activities.stopAll()]);
		this.onActivityStopped();
	}

	onActivityNotice(notice: ActivityNotice): void {
		if (this.#closed) {
			return;
		}
		if (this.#running) {
			this.steer(notice.message);
			return;
		}
		this.#pendingNotices = [
			...this.#pendingNotices.filter(
				(pending) => notice.replaceKey == null || pending.replaceKey !== notice.replaceKey,
			),
			notice,
		];
		this.#activityWaiters = this.#activityWaiters.filter((waiter) => {
			const wakeup = wakeupFor([notice], waiter.filter);
			if (wakeup === "none") return true;
			waiter.resolve(wakeup);
			return false;
		});
	}

	onActivityStopped(): void {
		if (this.#activityCount() > 0) {
			return;
		}
		for (const waiter of this.#activityWaiters.splice(0)) {
			waiter.resolve(wakeupFor(this.#pendingNotices, waiter.filter));
		}
	}

	async abort(): Promise<void> {
		if (!this.#running) {
			return;
		}
		this.#abortRequested = true;
		this.#retryWait?.cancel();
		this.#abortController?.abort(new Error("Agent session aborted"));
		if (this.#remoteSessionId !== undefined && this.#activeClient !== undefined) {
			this.#activeClient.cancel(this.#remoteSessionId);
		}
		await this.#runSettled;
	}

	setModel(selection: ModelSelection): void {
		this.#assertOpen();
		if (selection.provider !== ANTIGRAVITY_PROVIDER_ID) {
			throw new Error(
				`Cannot switch an open Antigravity session to provider ${selection.provider}`,
			);
		}
		this.#input.validateModel(selection);
		this.#modelSelection = selection;
		this.#modelDirty = true;
		this.#transcript.append({
			type: "model_change",
			at: this.#input.now().toISOString(),
			model: selection,
		});
	}

	async close(): Promise<void> {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		await this.abort();
		this.#setPhase("closed");
		this.#settleActivityWaiters();
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#input.unregisterMcp();
		const remoteSessionId = this.#remoteSessionId;
		const activeClient = this.#activeClient;
		this.#remoteSessionId = undefined;
		this.#activeClient = undefined;
		try {
			if (remoteSessionId !== undefined && isClientAlive(activeClient)) {
				await activeClient.closeSession(remoteSessionId).catch((error: unknown) => {
					this.#logger.warn("agent.antigravity.session_close_failed", {
						error: error instanceof Error ? error.message : String(error),
						sessionId: this.id,
					});
				});
			}
			await this.#transcript.flush();
			try {
				await this.#spec.activities.stopAll();
			} finally {
				await this.#input.disposeShell();
			}
		} finally {
			this.#input.onClosed(this.id);
		}
	}

	status(): AgentSessionStatus {
		return {
			id: this.id,
			kind: this.#spec.kind,
			label: this.#spec.label,
			model: this.#modelSelection,
			phase: this.#phase,
			phaseSince: this.#phaseSince,
			retries: this.#retries,
		};
	}

	async #execute(initialMessages: readonly AgentInputMessage[]): Promise<AgentRunResult> {
		this.#abortRequested = false;
		this.#retries = 0;
		this.#setPhase("running");
		this.#recordLunaInputs(initialMessages);

		let currentMessages: AgentInputMessage[] = [...initialMessages];
		let transientAttempts = 0;

		while (true) {
			this.#turnText = "";
			this.#inFlightSteers = [];
			this.#abortController = new AbortController();
			const signal = this.#abortController.signal;

			try {
				const client = await this.#ensureRemoteSession(signal);
				const remoteSessionId = this.#remoteSessionId;
				if (remoteSessionId === undefined) {
					throw new AcpProcessError("Antigravity ACP session was not initialized");
				}
				if (this.#modelDirty) {
					await this.#applyModelSelection(client, remoteSessionId, signal);
				}

				const promptText = currentMessages.map(formatLunaInput).join("\n\n");
				const result = await client.prompt(remoteSessionId, promptText, {
					signal,
					timeoutMs: this.#input.requestTimeoutMs,
				});

				// 実行中に並行で送った steer の応答をすべて回収する。
				let cancelled = result.stopReason === "cancelled";
				while (this.#inFlightSteers.length > 0) {
					const batch = this.#inFlightSteers.splice(0);
					const steerResults = await Promise.all(batch);
					for (const steerResult of steerResults) {
						if (isCancelledResult(steerResult)) {
							cancelled = true;
						}
					}
				}

				if (this.#isAbortRequested() || cancelled) {
					return { status: "aborted" };
				}

				// リモートセッションの起動中など steer を並行送信できなかった分が残っていれば続けて処理する。
				if (this.#pendingSteers.length > 0) {
					const followUp = this.#pendingSteers.splice(0);
					this.#recordLunaInputs(followUp);
					currentMessages = followUp;
					continue;
				}

				const finalText = this.#turnText.trim() === "" ? null : this.#turnText;
				this.#transcript.append({
					type: "message",
					at: this.#input.now().toISOString(),
					message: {
						role: "assistant",
						content: finalText == null ? [] : [{ type: "text", text: finalText }],
						stopReason: result.stopReason,
						usage: result.usage,
					},
				});
				this.#input.onRunCompleted();
				return { status: "completed", finalText };
			} catch (error: unknown) {
				if (this.#isAbortRequested()) {
					return { status: "aborted" };
				}
				if (
					error instanceof AcpTimeoutError &&
					this.#remoteSessionId !== undefined &&
					this.#activeClient !== undefined
				) {
					this.#activeClient.cancel(this.#remoteSessionId);
				}
				if (error instanceof AcpProcessError) {
					this.#detachRemoteSession();
				}

				const message = error instanceof Error ? error.message : String(error);
				const kind = classifyAcpError(error);
				if (kind !== "transient") {
					return this.#fail(kind, message);
				}
				const delayMs = this.#input.retryDelaysMs[transientAttempts];
				if (delayMs === undefined) {
					return this.#fail("transient_exhausted", message);
				}
				transientAttempts += 1;
				this.#retries += 1;
				this.#logger.warn("agent.antigravity.retry_scheduled", {
					attempt: transientAttempts,
					delayMs,
					error: message,
					sessionId: this.id,
				});
				if (!(await this.#waitForRetry(delayMs))) {
					return { status: "aborted" };
				}
				if (this.#pendingSteers.length > 0) {
					const steered = this.#pendingSteers.splice(0);
					this.#recordLunaInputs(steered);
					currentMessages = [...currentMessages, ...steered];
				}
				this.#setPhase("running");
			}
		}
	}

	async #ensureRemoteSession(signal: AbortSignal): Promise<AcpClientPort> {
		const activeClient = this.#activeClient;
		if (this.#remoteSessionId !== undefined && isClientAlive(activeClient)) {
			return activeClient;
		}
		this.#detachRemoteSession();
		const client = await this.#input.getClient();
		const created = await client.newSession(
			{
				cwd: this.#spec.cwd,
				additionalDirectories: [this.#input.scratchDir],
				mcpServers: [this.#input.mcpServer],
				systemPromptAppend: this.#input.systemPromptAppend,
			},
			signal,
		);
		this.#activeClient = client;
		this.#remoteSessionId = created.sessionId;
		this.#unsubscribe = client.subscribe(created.sessionId, (update) => {
			this.#handleUpdate(update);
		});
		await this.#applyModelSelection(client, created.sessionId, signal);
		return client;
	}

	async #applyModelSelection(
		client: AcpClientPort,
		remoteSessionId: string,
		signal: AbortSignal,
	): Promise<void> {
		await client.setConfigOption(remoteSessionId, "model", this.#modelSelection.model, signal);
		await client.setConfigOption(
			remoteSessionId,
			"thought_level",
			this.#modelSelection.thinking,
			signal,
		);
		this.#modelDirty = false;
	}

	#detachRemoteSession(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#remoteSessionId = undefined;
		this.#activeClient = undefined;
	}

	#handleUpdate(update: AcpSessionUpdate): void {
		if (
			update.sessionUpdate === "agent_message_chunk" &&
			typeof update.content?.text === "string"
		) {
			this.#turnText += update.content.text;
			return;
		}
		if (update.sessionUpdate === "tool_call" && update.name !== undefined) {
			this.#input.onToolCall?.(update.name, update.args);
			this.#transcript.append({
				type: "tool_call",
				at: this.#input.now().toISOString(),
				toolCallId: update.toolCallId,
				name: update.name,
				args: update.args,
				status: update.status,
			});
		}
	}

	#recordLunaInputs(messages: readonly AgentInputMessage[]): void {
		const at = this.#input.now().toISOString();
		const timestamp = this.#input.now().getTime();
		for (const message of messages) {
			this.#transcript.append({
				type: "message",
				at,
				message: { role: "luna_input", kind: message.kind, text: message.text, timestamp },
			});
		}
	}

	#activityCount(): number {
		return this.#input.background.count() + this.#spec.activities.count();
	}

	#settleActivityWaiters(): void {
		for (const waiter of this.#activityWaiters.splice(0)) {
			waiter.resolve("none");
		}
	}

	#fail(reason: AgentRunFailureReason, message: string): AgentRunResult {
		this.#logger.warn("agent.antigravity.run_failed", {
			error: message,
			reason,
			sessionId: this.id,
		});
		this.#input.onRunFailed(reason, message);
		return { status: "failed", reason, message };
	}

	#waitForRetry(delayMs: number): Promise<boolean> {
		if (this.#abortRequested) {
			return Promise.resolve(false);
		}
		this.#setPhase("retry_wait");
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.#retryWait = undefined;
				resolve(true);
			}, delayMs);
			this.#retryWait = {
				cancel: () => {
					clearTimeout(timer);
					this.#retryWait = undefined;
					resolve(false);
				},
			};
		});
	}

	#setPhase(phase: AgentSessionPhase): void {
		if (this.#phase === phase) {
			return;
		}
		this.#phase = phase;
		this.#phaseSince = this.#input.now().toISOString();
	}

	#isAbortRequested(): boolean {
		return this.#abortRequested;
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new SessionClosedError(this.id);
		}
	}
}

function isCancelledResult(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value != null &&
		"stopReason" in value &&
		value.stopReason === "cancelled"
	);
}

function wakeupFor(notices: readonly ActivityNotice[], filter: ActivityWaitFilter): ActivityWakeup {
	if (notices.some((notice) => notice.urgent)) return "urgent";
	if (filter === "any" && notices.length > 0) return "notice";
	return "none";
}
