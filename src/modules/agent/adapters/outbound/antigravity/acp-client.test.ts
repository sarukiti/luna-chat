import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRecordingLogger } from "../../../../observability/testing/recording-logger";
import {
	AcpProcessError,
	AcpRpcError,
	AcpTimeoutError,
	classifyAcpError,
	StdioAcpClient,
} from "./acp-client";
import type { AcpSessionUpdate } from "./acp-protocol";

const temporaryDirectories: string[] = [];
const clients: StdioAcpClient[] = [];

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function spawnFakeAcp(scriptSource: string): Promise<StdioAcpClient> {
	const dir = await mkdtemp(path.join(tmpdir(), "acp-client-test-"));
	temporaryDirectories.push(dir);
	const scriptPath = path.join(dir, "fake-acp.mjs");
	await writeFile(scriptPath, scriptSource, "utf8");
	const client = new StdioAcpClient({
		command: process.execPath,
		args: [scriptPath],
		cwd: dir,
		geminiDir: dir,
		logger: createRecordingLogger(),
	});
	clients.push(client);
	return client;
}

describe("StdioAcpClient", () => {
	it("initialize・newSession・setConfigOption・prompt・通知・権限自動承認・closeSession を処理する", async () => {
		const client = await spawnFakeAcp(`
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let pendingPromptId = null;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "fake", version: "1.0" } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    pendingPromptId = msg.id;
    send({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: { sessionId: "sess-1", options: [{ optionId: "allow_once" }] } });
  } else if (msg.id === 900 && msg.result) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "承認:" + msg.result.outcome.optionId } } } });
    send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "end_turn" } });
  } else if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`);

		const init = await client.initialize();
		expect(init.protocolVersion).toBe(1);

		const created = await client.newSession({
			cwd: "/workspace",
			additionalDirectories: ["/tmp/scratch"],
			mcpServers: [],
			systemPromptAppend: "あなたはルナ",
		});
		expect(created.sessionId).toBe("sess-1");

		const updates: AcpSessionUpdate[] = [];
		const unsubscribe = client.subscribe("sess-1", (update) => {
			updates.push(update);
		});
		await client.setConfigOption("sess-1", "model", "gemini-3.8-flash");
		const result = await client.prompt("sess-1", "こんにちは");
		unsubscribe();

		expect(result.stopReason).toBe("end_turn");
		expect(updates).toEqual([
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "承認:allow_once" },
			},
		]);
		await client.closeSession("sess-1");
	});

	it("JSON-RPC エラー・タイムアウト・不正レスポンス・プロセス異常終了を型付きエラーにする", async () => {
		const client = await spawnFakeAcp(`
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Authentication required" } });
  } else if (msg.method === "session/prompt") {
    const text = msg.params.prompt[0].text;
    if (text === "invalid") {
      send({ jsonrpc: "2.0", id: msg.id, result: { unexpected: true } });
    } else if (text === "crash") {
      process.stderr.write("boom\\n");
      process.exit(1);
    }
    // "hang" は応答しない
  }
});
`);

		await client.initialize();
		await expect(client.newSession({ cwd: "/workspace", mcpServers: [] })).rejects.toMatchObject({
			name: "AcpRpcError",
			code: -32_000,
			message: "Authentication required",
		});
		await expect(client.prompt("s", "hang", { timeoutMs: 40 })).rejects.toBeInstanceOf(
			AcpTimeoutError,
		);
		await expect(client.prompt("s", "invalid")).rejects.toBeInstanceOf(AcpProcessError);
		await expect(client.prompt("s", "crash")).rejects.toThrow("Antigravity ACP exited with code 1");
		expect(client.isAlive()).toBe(false);
	});

	it("prompt は session/update が届き続ける間はタイムアウトをリセットし、無応答が続いた時だけタイムアウトする", async () => {
		const client = await spawnFakeAcp(`
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    const text = msg.params.prompt[0].text;
    if (text === "active") {
      let count = 0;
      const timer = setInterval(() => {
        count += 1;
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: String(count) } } } });
        if (count >= 4) {
          clearInterval(timer);
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        }
      }, 40);
    } else if (text === "stall-after-one") {
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "once" } } } });
      }, 30);
    }
  }
});
`);

		await client.initialize();
		// 40ms × 4回 = 160ms かかるが、各間隔が timeoutMs(100ms) 未満なので完了する。
		const ok = await client.prompt("sess-idle", "active", { timeoutMs: 100 });
		expect(ok.stopReason).toBe("end_turn");

		// 1回だけ通知したあと無応答が続けば timeoutMs 後にタイムアウトする。
		await expect(
			client.prompt("sess-idle", "stall-after-one", { timeoutMs: 80 }),
		).rejects.toBeInstanceOf(AcpTimeoutError);
	});
});

describe("classifyAcpError", () => {
	it("認証・上限・一時的障害・致命的エラーを分類する", () => {
		expect(classifyAcpError(new AcpRpcError(-32_000, "Authentication required"))).toBe(
			"auth_required",
		);
		expect(classifyAcpError(new AcpRpcError(-32_001, "429 RESOURCE_EXHAUSTED"))).toBe(
			"usage_limit",
		);
		expect(classifyAcpError(new AcpTimeoutError("timed out"))).toBe("transient");
		expect(classifyAcpError(new AcpProcessError("exited"))).toBe("transient");
		expect(classifyAcpError(new AcpRpcError(-32_602, "Invalid params"))).toBe("fatal");
	});
});
