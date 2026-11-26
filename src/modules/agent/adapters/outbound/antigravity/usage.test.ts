import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fetchAntigravityUsage, parseAntigravityUsage } from "./usage";

const SAMPLE_USAGE_JSON = {
	conversation_id: "",
	status: "SUCCESS",
	response:
		"Gemini Models\tWeekly Limit Remaining\t99%\t2026-12-03T07:27:37Z\nGemini Models\tFive Hour Limit Remaining\t97%\t2026-11-26T12:27:37Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z\nClaude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z\n",
	duration_seconds: 0,
	num_turns: 0,
	usage: {
		input_tokens: 0,
		output_tokens: 0,
		thinking_tokens: 0,
		cache_read_tokens: 0,
		total_tokens: 0,
	},
	command: {
		name: "usage",
		data: {
			description: "Within each group, models share a weekly limit and a 5-hour limit.",
			groups: [
				{
					name: "Gemini Models",
					description: "Models within this group: Gemini 4 Neon, Gemini 3.8 Flash",
					buckets: [
						{
							id: "gemini-weekly",
							name: "Weekly Limit Remaining",
							description: "You have used some of your weekly limit.",
							window: "weekly",
							remaining_fraction: 0.993_597_626_686_096_2,
							reset_time: "2026-12-03T07:27:37Z",
						},
						{
							id: "gemini-5h",
							name: "Five Hour Limit Remaining",
							description: "You have used some of your 5-hour limit.",
							window: "5h",
							remaining_fraction: 0.974_390_387_535_095_2,
							reset_time: "2026-11-26T12:27:37Z",
						},
					],
				},
				{
					name: "Claude and GPT models",
					description: "Models within this group: Claude Opus 5.5, GPT-OSS 120B",
					buckets: [
						{
							id: "3p-weekly",
							name: "Weekly Limit Remaining",
							window: "weekly",
							remaining_fraction: 1,
							reset_time: "1970-01-01T00:00:00Z",
						},
						{
							id: "3p-5h",
							name: "Five Hour Limit Remaining",
							window: "5h",
							remaining_fraction: 1,
							reset_time: "1970-01-01T00:00:00Z",
						},
					],
				},
			],
		},
	},
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createFakeAgyScript(body: string): Promise<{ dir: string; command: string }> {
	const dir = await mkdtemp(path.join(tmpdir(), "antigravity-usage-test-"));
	temporaryDirectories.push(dir);
	const command = path.join(dir, "fake-agy.sh");
	await writeFile(command, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
	await chmod(command, 0o755);
	return { dir, command };
}

describe("parseAntigravityUsage", () => {
	it("agy -p /usage のJSON出力を UsageSnapshot に変換する", () => {
		const snapshot = parseAntigravityUsage(SAMPLE_USAGE_JSON, "2026-11-26T07:51:47.000Z");

		expect(snapshot).toEqual({
			fetchedAt: "2026-11-26T07:51:47.000Z",
			planType: "antigravity",
			limits: [
				{
					limitId: "antigravity:gemini",
					primary: {
						usedPercent: 2.56,
						windowMinutes: 300,
						resetsAt: "2026-11-26T12:27:37.000Z",
					},
					secondary: {
						usedPercent: 0.64,
						windowMinutes: 10_080,
						resetsAt: "2026-12-03T07:27:37.000Z",
					},
				},
				{
					limitId: "antigravity:3p",
					primary: {
						usedPercent: 0,
						windowMinutes: 300,
						resetsAt: null,
					},
					secondary: {
						usedPercent: 0,
						windowMinutes: 10_080,
						resetsAt: null,
					},
				},
			],
		});
	});

	it("remaining_fraction を 0..100 にクランプし、未知のID形式やリセット時刻も安全に扱う", () => {
		const snapshot = parseAntigravityUsage(
			{
				status: "SUCCESS",
				command: {
					name: "usage",
					data: {
						groups: [
							{
								name: "Experimental Models",
								buckets: [
									{
										window: "5h",
										remaining_fraction: -0.25,
										reset_time: "0001-01-01T00:00:00Z",
									},
									{
										window: "weekly",
										remaining_fraction: 1.5,
										reset_time: "",
									},
								],
							},
						],
					},
				},
			},
			"2026-11-26T08:00:00.000Z",
		);

		expect(snapshot).toEqual({
			fetchedAt: "2026-11-26T08:00:00.000Z",
			planType: "antigravity",
			limits: [
				{
					limitId: "antigravity:experimental_models",
					primary: { usedPercent: 100, windowMinutes: 300, resetsAt: null },
					secondary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: null },
				},
			],
		});
	});

	it("status が SUCCESS 以外、または不正なペイロードはエラーにする", () => {
		expect(() =>
			parseAntigravityUsage({ ...SAMPLE_USAGE_JSON, status: "ERROR" }, "2026-11-26T08:00:00.000Z"),
		).toThrow("non-success status");

		expect(() => parseAntigravityUsage({ status: "SUCCESS" }, "2026-11-26T08:00:00.000Z")).toThrow(
			"Invalid Antigravity /usage payload",
		);
	});
});

describe("fetchAntigravityUsage", () => {
	it("geminiDir を一時 HOME/.gemini へリンクして agy -p /usage を実行し、結果を返す", async () => {
		const { dir, command } = await createFakeAgyScript(
			`
if [ "$1" != "-p" ] || [ "$2" != "/usage" ] || [ "$3" != "--output-format" ] || [ "$4" != "json" ]; then
  echo "unexpected args: $*" >&2
  exit 2
fi
if [ ! -f "$HOME/.gemini/marker" ]; then
  echo "missing gemini dir marker in $HOME/.gemini" >&2
  exit 3
fi
cat <<'JSON'
${JSON.stringify(SAMPLE_USAGE_JSON)}
JSON
`,
		);
		const geminiDir = path.join(dir, "antigravity");
		await mkdir(geminiDir, { recursive: true });
		await writeFile(path.join(geminiDir, "marker"), "ok", "utf8");

		const snapshot = await fetchAntigravityUsage(
			{
				command,
				cwd: dir,
				geminiDir,
				now: () => new Date("2026-11-26T07:51:47.000Z"),
			},
			new AbortController().signal,
		);

		expect(snapshot.planType).toBe("antigravity");
		expect(snapshot.limits).toHaveLength(2);
		expect(snapshot.limits[0]?.limitId).toBe("antigravity:gemini");
		expect(snapshot.limits[0]?.primary?.usedPercent).toBe(2.56);
	});

	it("終了コードが0以外のときはstderr付きで失敗する", async () => {
		const { dir, command } = await createFakeAgyScript(`echo "auth failed" >&2\nexit 1`);

		await expect(
			fetchAntigravityUsage({ command, cwd: dir }, new AbortController().signal),
		).rejects.toThrow("exited with code 1: auth failed");
	});

	it("timeoutMs を超えたらプロセスを終了してタイムアウトエラーにする", async () => {
		const { dir, command } = await createFakeAgyScript("sleep 10");

		await expect(
			fetchAntigravityUsage({ command, cwd: dir, timeoutMs: 50 }, new AbortController().signal),
		).rejects.toThrow("timed out");
	});

	it("AbortSignal で中断したら即座にエラーにする", async () => {
		const { dir, command } = await createFakeAgyScript("sleep 10");
		const controller = new AbortController();
		const running = fetchAntigravityUsage(
			{ command, cwd: dir, timeoutMs: 5_000 },
			controller.signal,
		);

		setTimeout(() => controller.abort(new Error("cancelled by caller")), 30);

		await expect(running).rejects.toThrow("cancelled by caller");
	});
});
