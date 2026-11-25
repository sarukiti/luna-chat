import { z } from "zod";

import type { AgentModel, ThinkingLevel } from "../../../ports/outbound/agent-session-port";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

const acpRpcErrorSchema = z.looseObject({
	code: z.number(),
	message: z.string(),
	data: z.unknown().optional(),
});

export const acpIncomingMessageSchema = z.looseObject({
	jsonrpc: z.literal("2.0").optional(),
	id: z.union([z.number(), z.string()]).optional(),
	method: z.string().optional(),
	params: z.unknown().optional(),
	result: z.unknown().optional(),
	error: acpRpcErrorSchema.optional(),
});

export const acpInitializeResultSchema = z.looseObject({
	protocolVersion: z.number(),
	agentCapabilities: z.looseObject({}).optional(),
	agentInfo: z
		.looseObject({
			name: z.string(),
			version: z.string(),
		})
		.optional(),
});

export type AcpInitializeResult = z.infer<typeof acpInitializeResultSchema>;

const acpConfigOptionValueSchema = z.looseObject({
	value: z.string(),
	name: z.string(),
});

const acpConfigOptionSchema = z.looseObject({
	id: z.string(),
	category: z.string().optional(),
	currentValue: z.string().optional(),
	options: z.array(acpConfigOptionValueSchema).optional(),
});

const acpAvailableModelSchema = z.looseObject({
	modelId: z.string(),
	name: z.string(),
});

export const acpSessionNewResultSchema = z.looseObject({
	sessionId: z.string().min(1),
	models: z
		.looseObject({
			availableModels: z.array(acpAvailableModelSchema).optional(),
			currentModelId: z.string().optional(),
		})
		.optional(),
	configOptions: z.array(acpConfigOptionSchema).optional(),
});

export type AcpSessionNewResult = z.infer<typeof acpSessionNewResultSchema>;

export const acpSetConfigOptionResultSchema = z.looseObject({
	configOptions: z.array(acpConfigOptionSchema).optional(),
});

export const acpEmptyResultSchema = z.looseObject({});

const acpPromptUsageSchema = z.looseObject({
	inputTokens: z.number().optional(),
	outputTokens: z.number().optional(),
	cachedReadTokens: z.number().optional(),
	cachedWriteTokens: z.number().optional(),
	thoughtTokens: z.number().optional(),
	totalTokens: z.number().optional(),
});

export const acpPromptResultSchema = z.looseObject({
	stopReason: z.string(),
	usage: acpPromptUsageSchema.optional(),
});

export type AcpPromptResult = z.infer<typeof acpPromptResultSchema>;

const acpSessionUpdateSchema = z.looseObject({
	sessionUpdate: z.string(),
	content: z
		.looseObject({
			type: z.string().optional(),
			text: z.string().optional(),
		})
		.optional(),
	toolCallId: z.string().optional(),
	name: z.string().optional(),
	args: z.unknown().optional(),
	status: z.string().optional(),
	title: z.string().optional(),
});

export type AcpSessionUpdate = z.infer<typeof acpSessionUpdateSchema>;

export const acpSessionUpdateParamsSchema = z.looseObject({
	sessionId: z.string(),
	update: acpSessionUpdateSchema,
});

export const acpRequestPermissionParamsSchema = z.looseObject({
	sessionId: z.string().optional(),
	options: z
		.array(
			z.looseObject({
				optionId: z.string(),
			}),
		)
		.optional(),
});

export type AcpMcpServerConfig = Readonly<{
	type: "http";
	name: string;
	url: string;
	headers: readonly Readonly<{ name: string; value: string }>[];
}>;

// session/new の configOptions（model / thought_level）と models.availableModels から
// Luna のモデルカタログ（provider/model と対応する thinking 一覧）を組み立てる。
export function extractAntigravityModels(result: AcpSessionNewResult): AgentModel[] {
	const modelConfig = result.configOptions?.find((option) => option.id === "model");
	const thoughtConfig = result.configOptions?.find((option) => option.id === "thought_level");
	const defaultLevels = parseThinkingLevels(thoughtConfig?.options?.map((option) => option.value));
	const availableIds = new Set(result.models?.availableModels?.map((model) => model.modelId) ?? []);

	const modelOptions = modelConfig?.options ?? [];
	if (modelOptions.length === 0) {
		return (result.models?.availableModels ?? []).map((model) => ({
			provider: ANTIGRAVITY_PROVIDER_ID,
			model: model.modelId,
			displayName: model.name,
			supportedThinkingLevels: inferThinkingLevelsForModel(
				model.modelId,
				availableIds,
				defaultLevels,
			),
		}));
	}

	return modelOptions.map((option) => ({
		provider: ANTIGRAVITY_PROVIDER_ID,
		model: option.value,
		displayName: option.name,
		supportedThinkingLevels: inferThinkingLevelsForModel(option.value, availableIds, defaultLevels),
	}));
}

function parseThinkingLevels(values: readonly string[] | undefined): ThinkingLevel[] {
	if (values === undefined) return [];
	const parsed: ThinkingLevel[] = [];
	for (const value of values) {
		const result = thinkingLevelSchema.safeParse(value);
		if (result.success) parsed.push(result.data);
	}
	return parsed;
}

function inferThinkingLevelsForModel(
	modelId: string,
	availableIds: ReadonlySet<string>,
	defaultLevels: readonly ThinkingLevel[],
): readonly ThinkingLevel[] {
	const bySuffix = ALL_THINKING_LEVELS.filter((level) => availableIds.has(`${modelId}-${level}`));
	if (bySuffix.length > 0) {
		return bySuffix;
	}
	for (const level of ALL_THINKING_LEVELS) {
		if (modelId.endsWith(`-${level}`)) {
			return [level];
		}
	}
	return defaultLevels.length > 0 ? defaultLevels : ["medium"];
}
