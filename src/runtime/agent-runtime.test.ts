import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_CONFIG } from "../modules/workspace/domain/workspace-config";
import { activeModelSelectionsOf, createAgentModels, usesProvider } from "./agent-runtime";

describe("createAgentModels", () => {
	const models = createAgentModels("/nonexistent/luna-home");

	it("pi-ai のカタログにない gpt-6.2-sol を 6.1 Sol と同じ定義で足す", () => {
		const gpt61Sol = models.getModel("openai-codex", "gpt-6.1-sol");
		const gpt62Sol = models.getModel("openai-codex", "gpt-6.2-sol");

		expect(gpt61Sol).toBeDefined();
		expect(gpt62Sol).toEqual({ ...gpt61Sol, id: "gpt-6.2-sol", name: "GPT-6.2 Sol" });
		expect(gpt62Sol?.contextWindow).toBe(500_000);
		if (gpt62Sol === undefined) return;
		expect(getSupportedThinkingLevels(gpt62Sol)).not.toContain("off");
	});

	it("pi-ai のカタログにない gpt-6.2-astra を 6 Astra の定義と 6.2 Astra の料金で足す", () => {
		const gpt6Astra = models.getModel("openai-codex", "gpt-6-astra");
		const gpt62Astra = models.getModel("openai-codex", "gpt-6.2-astra");

		expect(gpt6Astra).toBeDefined();
		expect(gpt62Astra).toEqual({
			...gpt6Astra,
			id: "gpt-6.2-astra",
			name: "GPT-6.2 Astra",
			cost: {
				input: 8,
				output: 40,
				cacheRead: 0.4,
				cacheWrite: 10,
				tiers: [
					{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 },
				],
			},
		});
		expect(gpt62Astra?.contextWindow).toBe(272_000);
		if (gpt62Astra === undefined) return;
		expect(getSupportedThinkingLevels(gpt62Astra)).not.toContain("off");
	});

	it("足したモデルは一覧に1件ずつだけ載る", () => {
		const ids = models.getModels("openai-codex").map((model) => model.id);

		expect(ids.filter((id) => id === "gpt-6.2-sol")).toHaveLength(1);
		expect(ids.filter((id) => id === "gpt-6.2-astra")).toHaveLength(1);
	});
});

describe("activeModelSelectionsOf", () => {
	it("すべての実行モデルが antigravity のときは未使用の compaction と voice を含めない", () => {
		const agy = { provider: "antigravity", model: "gemini-4-neon", thinking: "high" as const };
		const selections = activeModelSelectionsOf({
			models: {
				...DEFAULT_WORKSPACE_CONFIG.models,
				conversation: agy,
				event: agy,
				worker: {
					default: "standard",
					choices: { standard: { ...agy, description: "general" } },
				},
			},
		});

		expect(usesProvider(selections, "antigravity")).toBe(true);
		expect(usesProvider(selections, "openai-codex")).toBe(false);
		expect(selections).not.toHaveProperty("compaction");
		expect(selections).not.toHaveProperty("voice");
	});
});
