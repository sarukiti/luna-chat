import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import type { UsageSnapshot, UsageWindow } from "../../../ports/outbound/agent-session-port";

const DEFAULT_COMMAND = "agy";
const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const STDOUT_LIMIT_BYTES = 1_048_576;
const STDERR_TAIL_LIMIT = 16_384;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

const bucketSchema = z.looseObject({
	id: z.string().optional(),
	name: z.string().optional(),
	window: z.string().min(1),
	remaining_fraction: z.number(),
	reset_time: z.string().nullish(),
});

const groupSchema = z.looseObject({
	name: z.string().min(1),
	buckets: z.array(bucketSchema),
});

const usageOutputSchema = z.looseObject({
	status: z.string(),
	command: z.looseObject({
		name: z.literal("usage"),
		data: z.looseObject({
			groups: z.array(groupSchema),
		}),
	}),
});

type UsageBucket = z.infer<typeof bucketSchema>;
type UsageGroup = z.infer<typeof groupSchema>;

export type FetchAntigravityUsageOptions = Readonly<{
	command?: string;
	cwd: string;
	geminiDir?: string;
	env?: Readonly<Record<string, string | undefined>>;
	timeoutMs?: number;
	now?: () => Date;
}>;

export async function fetchAntigravityUsage(
	options: FetchAntigravityUsageOptions,
	signal: AbortSignal,
): Promise<UsageSnapshot> {
	signal.throwIfAborted();
	const command = options.command ?? DEFAULT_COMMAND;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = options.now ?? (() => new Date());

	let tempHome: string | undefined;
	try {
		const baseEnv = options.env ?? process.env;
		let env: Record<string, string>;
		if (options.geminiDir !== undefined) {
			// agy -p /usage は --gemini-dir を受け付けず $HOME/.gemini を参照するため、一時 HOME で差し替える。
			tempHome = await mkdtemp(path.join(tmpdir(), "luna-agy-usage-"));
			await symlink(options.geminiDir, path.join(tempHome, ".gemini"));
			env = buildChildEnv({ ...baseEnv, HOME: tempHome });
		} else {
			env = buildChildEnv(baseEnv);
		}

		const stdout = await runUsageCommand({
			command,
			args: ["-p", "/usage", "--output-format", "json"],
			cwd: options.cwd,
			env,
			timeoutMs,
			signal,
		});

		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(stdout.trim());
		} catch (error: unknown) {
			throw new Error(
				`Antigravity /usage returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		return parseAntigravityUsage(parsedJson, now().toISOString());
	} finally {
		if (tempHome !== undefined) {
			await rm(tempHome, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

export function parseAntigravityUsage(raw: unknown, fetchedAt: string): UsageSnapshot {
	const parsed = usageOutputSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(`Invalid Antigravity /usage payload: ${parsed.error.message}`);
	}
	if (parsed.data.status !== "SUCCESS") {
		throw new Error(`Antigravity /usage returned non-success status: ${parsed.data.status}`);
	}
	return {
		fetchedAt,
		planType: "antigravity",
		limits: parsed.data.command.data.groups.map(toLimit),
	};
}

function toLimit(group: UsageGroup): UsageSnapshot["limits"][number] {
	let primary: UsageWindow | null = null;
	let secondary: UsageWindow | null = null;
	const extra: UsageWindow[] = [];

	for (const bucket of group.buckets) {
		const converted = toWindow(bucket);
		if (converted == null) continue;
		const normalizedWindow = bucket.window.trim().toLowerCase();
		if (normalizedWindow === "5h" && primary == null) {
			primary = converted;
		} else if (normalizedWindow === "weekly" && secondary == null) {
			secondary = converted;
		} else {
			extra.push(converted);
		}
	}

	if (extra.length > 0) {
		extra.sort((left, right) => left.windowMinutes - right.windowMinutes);
		primary ??= extra.shift() ?? null;
		secondary ??= extra.pop() ?? null;
	}

	return {
		limitId: resolveLimitId(group),
		primary,
		secondary,
	};
}

function resolveLimitId(group: UsageGroup): string {
	for (const bucket of group.buckets) {
		if (bucket.id === undefined) continue;
		const suffix = `-${bucket.window}`;
		if (bucket.id.endsWith(suffix) && bucket.id.length > suffix.length) {
			return `antigravity:${bucket.id.slice(0, -suffix.length)}`;
		}
	}
	const slug = group.name
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, "_")
		.replaceAll(/^_+|_+$/gu, "");
	return `antigravity:${slug === "" ? "usage" : slug}`;
}

function toWindow(bucket: UsageBucket): UsageWindow | null {
	const windowMinutes = parseWindowMinutes(bucket.window);
	if (windowMinutes == null) return null;
	const clampedRemaining = Math.min(1, Math.max(0, bucket.remaining_fraction));
	const usedPercent = Math.round((1 - clampedRemaining) * 10_000) / 100;
	return {
		usedPercent: Object.is(usedPercent, -0) ? 0 : usedPercent,
		windowMinutes,
		resetsAt: parseResetTime(bucket.reset_time),
	};
}

function parseWindowMinutes(window: string): number | null {
	const normalized = window.trim().toLowerCase();
	if (normalized === "weekly") return MINUTES_PER_WEEK;
	if (normalized === "daily") return MINUTES_PER_DAY;
	const match = /^(\d+)(m|h|d|w)$/u.exec(normalized);
	if (match == null) return null;
	const amount = Number(match[1]);
	if (!Number.isSafeInteger(amount) || amount <= 0) return null;
	switch (match[2]) {
		case "m":
			return amount;
		case "h":
			return amount * MINUTES_PER_HOUR;
		case "d":
			return amount * MINUTES_PER_DAY;
		case "w":
			return amount * MINUTES_PER_WEEK;
		default:
			return null;
	}
}

function parseResetTime(resetTime: string | null | undefined): string | null {
	if (resetTime == null || resetTime.trim() === "") return null;
	const epochMs = Date.parse(resetTime);
	// 未消費の枠では 1970-01-01T00:00:00Z が返るため、エポック以下は未設定として扱う。
	if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
	return new Date(epochMs).toISOString();
}

function runUsageCommand(input: {
	command: string;
	args: readonly string[];
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
	signal: AbortSignal;
}): Promise<string> {
	return new Promise<string>((resolveOutput, rejectOutput) => {
		const child = spawn(input.command, [...input.args], {
			cwd: input.cwd,
			env: input.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stdoutBytes = 0;
		let stdoutOverflow = false;
		let stderr = "";
		let settled = false;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;

		const terminate = () => {
			if (child.exitCode != null) return;
			signalProcessGroup(child, "SIGTERM");
			if (killTimer === undefined) {
				killTimer = setTimeout(() => {
					if (child.exitCode == null) {
						signalProcessGroup(child, "SIGKILL");
					}
				}, KILL_GRACE_MS);
				killTimer.unref();
			}
		};

		const cleanup = () => {
			if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
			if (killTimer !== undefined) clearTimeout(killTimer);
			input.signal.removeEventListener("abort", onAbort);
		};

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};

		const onAbort = () => {
			terminate();
			finish(() => {
				const reason: unknown = input.signal.reason;
				rejectOutput(reason instanceof Error ? reason : new Error("Antigravity /usage aborted"));
			});
		};

		input.signal.addEventListener("abort", onAbort, { once: true });

		timeoutTimer = setTimeout(() => {
			terminate();
			finish(() => {
				rejectOutput(new Error(`Antigravity /usage timed out after ${String(input.timeoutMs)}ms`));
			});
		}, input.timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.byteLength;
			if (stdoutBytes > STDOUT_LIMIT_BYTES) {
				stdoutOverflow = true;
				terminate();
				return;
			}
			stdout += chunk.toString("utf8");
		});

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-STDERR_TAIL_LIMIT);
		});

		child.once("error", (error) => {
			finish(() => {
				rejectOutput(
					new Error(`Failed to execute Antigravity /usage (${input.command}): ${error.message}`, {
						cause: error,
					}),
				);
			});
		});

		child.once("close", (code, exitSignal) => {
			finish(() => {
				if (stdoutOverflow) {
					rejectOutput(
						new Error(`Antigravity /usage output exceeded ${String(STDOUT_LIMIT_BYTES)} bytes`),
					);
					return;
				}
				if (code === 0) {
					resolveOutput(stdout);
					return;
				}
				const detail = stderr.trim().slice(-500);
				const suffix = detail === "" ? "" : `: ${detail}`;
				const reason =
					code == null
						? `Antigravity /usage exited from signal ${exitSignal ?? "unknown"}${suffix}`
						: `Antigravity /usage exited with code ${String(code)}${suffix}`;
				rejectOutput(new Error(reason));
			});
		});
	});
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
