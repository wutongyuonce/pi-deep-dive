#!/usr/bin/env node
// 上面这行是 shebang，告诉系统用 node 执行这个脚本

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { AnthropicMessagesCompat, Api, Model } from "../src/types.ts";

// ESM 模块中获取当前文件路径（ESM 没有 __filename / __dirname）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// 包根目录：packages/ai/
const packageRoot = join(__dirname, "..");

// =============================================================================
// 类型定义
// =============================================================================

/**
 * models.dev API 返回的模型数据结构。
 * 这是一个第三方服务（https://models.dev），聚合了各厂商的模型元信息。
 */
interface ModelsDevModel {
	id: string;
	name: string;
	/** 是否支持工具调用。pi-ai 只关心支持工具调用的模型。 */
	tool_call?: boolean;
	/** 是否支持推理/思考。 */
	reasoning?: boolean;
	/** token 限制。 */
	limit?: {
		context?: number;  // 上下文窗口大小
		output?: number;   // 最大输出 token 数
	};
	/** 计费单价（美元/百万 token）。 */
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	/** 支持的模态（文本 / 图片）。 */
	modalities?: {
		input?: string[];
	};
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 支持 `off: "none"` 推理级别的 OpenAI Responses 模型。
 *
 * 这些模型虽然支持推理，但 `off` 级别映射为 "none"（而非 null/不支持）。
 * 与 GPT-5 系列（off: null，完全不支持关闭推理）不同。
 */
const OPENAI_RESPONSES_NONE_REASONING_MODELS = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
]);

/**
 * 合并推理级别映射表。
 *
 * 直接修改 model.thinkingLevelMap 对象（副作用）。
 * 新的 map 会覆盖已有的同名 key。
 *
 * @example
 * mergeThinkingLevelMap(model, { off: null, xhigh: "max" });
 * // model.thinkingLevelMap 现在包含 { off: null, xhigh: "max" }
 */
function mergeThinkingLevelMap(model: Model<any>, map: NonNullable<Model<any>["thinkingLevelMap"]>): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

/**
 * 判断 OpenAI 模型是否支持 xhigh 推理级别。
 *
 * 目前只有 GPT-5.2、5.3、5.4、5.5 系列支持。
 */
function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5")
	);
}

/**
 * 判断 Anthropic 模型是否使用自适应思考（adaptive thinking）。
 *
 * 自适应思考是 Anthropic 的新特性：模型自己决定何时/思考多深。
 * 与旧的基于 token 预算的思考方式不同。
 */
function isAnthropicAdaptiveThinkingModel(modelId: string): boolean {
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("opus-4-7") ||
		modelId.includes("opus-4.7") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6")
	);
}

/**
 * 合并 Anthropic 兼容性配置。
 *
 * 与 mergeThinkingLevelMap 类似，但操作的是 model.compat 字段。
 */
function mergeAnthropicMessagesCompat(model: Model<Api>, compat: AnthropicMessagesCompat): void {
	model.compat = { ...(model.compat as AnthropicMessagesCompat | undefined), ...compat };
}

/**
 * 根据模型 ID 应用推理级别元数据。
 *
 * 这个函数是整个脚本最复杂的逻辑之一，它根据模型的 ID 和 API 类型，
 * 设置正确的 thinkingLevelMap 和 compat 配置。
 *
 * 为什么需要这个函数：
 * - 不同模型对推理级别的支持不同
 * - 同一个 API 协议下的不同模型可能有不同的行为
 * - 需要根据模型 ID 精确判断
 *
 * 规则总结：
 * - GPT-5 系列：off = null（不支持关闭推理）
 * - 特定 GPT-5 模型：off = "none"（支持关闭，映射为 "none"）
 * - GPT-5.2/5.3/5.4/5.5：支持 xhigh
 * - Claude Opus 4.6：xhigh = "max"
 * - Claude Opus 4.7：xhigh = "xhigh"
 * - Claude 自适应模型：强制启用 forceAdaptiveThinking
 */
function applyThinkingLevelMetadata(model: Model<any>): void {
	// GPT-5 系列（OpenAI Responses 和 Azure）：不支持关闭推理
	if (
		(model.api === "openai-responses" || model.api === "azure-openai-responses") &&
		model.id.startsWith("gpt-5")
	) {
		mergeThinkingLevelMap(model, { off: null });
	}

	// 特定 GPT-5 模型：支持关闭推理，映射为 "none"
	if (
		model.api === "openai-responses" &&
		model.provider === "openai" &&
		OPENAI_RESPONSES_NONE_REASONING_MODELS.has(model.id)
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}

	// GPT-5.2/5.3/5.4/5.5：支持 xhigh 推理级别
	if (supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}

	// Claude Opus 4.6：xhigh 映射为 Anthropic 的 "max"
	if (model.id.includes("opus-4-6") || model.id.includes("opus-4.6")) {
		mergeThinkingLevelMap(model, { xhigh: "max" });
	}

	// Claude Opus 4.7：xhigh 映射为 "xhigh"
	if (model.id.includes("opus-4-7") || model.id.includes("opus-4.7")) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}

	// Claude 自适应思考模型：强制启用自适应思考模式
	if (model.api === "anthropic-messages" && isAnthropicAdaptiveThinkingModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { forceAdaptiveThinking: true });
	}
}

// =============================================================================
// 核心函数
// =============================================================================

/**
 * 从 models.dev API 加载所有支持工具调用的模型数据。
 *
 * models.dev 是一个第三方服务，聚合了各厂商的模型元信息（ID、名称、价格、能力等）。
 * 这个函数只加载支持 tool_call 的模型（pi-ai 的核心需求）。
 *
 * 加载逻辑：
 * 1. 请求 models.dev/api.json
 * 2. 遍历 anthropic、openai、deepseek 三个厂商的模型
 * 3. 过滤掉不支持工具调用的模型
 * 4. 转换成 pi-ai 的 Model 格式
 *
 * 注意：DeepSeek 使用 openai-completions 协议（OpenAI 兼容），但 provider 是 "deepseek"。
 */
async function loadModelsDevData(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		const data = await response.json();

		const models: Model<any>[] = [];

		// -------------------------------------------------------------------------
		// Anthropic 模型：使用 anthropic-messages 协议
		// -------------------------------------------------------------------------
		if (data.anthropic?.models) {
			for (const [modelId, model] of Object.entries(data.anthropic.models)) {
				const m = model as ModelsDevModel;
				// 只保留支持工具调用的模型
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",      // 使用 Anthropic Messages 协议
					provider: "anthropic",            // 服务商是 Anthropic
					baseUrl: "https://api.anthropic.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// -------------------------------------------------------------------------
		// OpenAI 模型：使用 openai-responses 协议（新的 Responses API）
		// -------------------------------------------------------------------------
		if (data.openai?.models) {
			for (const [modelId, model] of Object.entries(data.openai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",          // 使用 OpenAI Responses 协议
					provider: "openai",                // 服务商是 OpenAI
					baseUrl: "https://api.openai.com/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// -------------------------------------------------------------------------
		// DeepSeek 模型：使用 openai-completions 协议（OpenAI 兼容）
		// -------------------------------------------------------------------------
		// 关键点：DeepSeek 兼容 OpenAI 的 API，所以复用 openai-completions 协议实现
		// 但 provider 是 "deepseek"，用于读取 DEEPSEEK_API_KEY 环境变量
		if (data.deepseek?.models) {
			for (const [modelId, model] of Object.entries(data.deepseek.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",        // 复用 OpenAI Completions 协议
					provider: "deepseek",              // 但服务商是 DeepSeek
					baseUrl: "https://api.deepseek.com/v1",  // 请求发到 DeepSeek 服务器
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: {
						supportsDeveloperRole: false,  // DeepSeek 不支持 developer 角色
					},
				});
			}
		}

		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		return [];
	}
}

/**
 * 主生成函数：加载模型数据 → 修正/补充 → 生成 TypeScript 文件。
 *
 * 完整流程：
 * 1. 从 models.dev 加载模型数据
 * 2. 修正 models.dev 中不准确的数据（价格、上下文窗口等）
 * 3. 补充 models.dev 中缺失的模型（如新发布的模型）
 * 4. 生成 Azure OpenAI 模型（从 OpenAI 模型复制，改 api 和 provider）
 * 5. 应用推理级别元数据
 * 6. 按 provider 分组、去重
 * 7. 生成 models.generated.ts 文件
 */
async function generateModels() {
	const allModels = await loadModelsDevData();

	// =========================================================================
	// 第一步：修正 models.dev 中不准确的数据
	// =========================================================================

	// 修正 Claude Opus 4.5 的缓存价格（models.dev 数据有误）
	const opus45 = allModels.find(m => m.provider === "anthropic" && m.id === "claude-opus-4-5");
	if (opus45) {
		opus45.cost.cacheRead = 0.5;
		opus45.cost.cacheWrite = 6.25;
	}

	// 临时覆盖：等上游修正后可以移除
	for (const candidate of allModels) {
		// Claude 4.6 系列：上下文窗口应为 1M
		if (
			candidate.provider === "anthropic" &&
			(candidate.id === "claude-opus-4-6" ||
				candidate.id === "claude-sonnet-4-6" ||
				candidate.id === "claude-opus-4.6" ||
				candidate.id === "claude-sonnet-4.6")
		) {
			candidate.contextWindow = 1000000;
		}
		// GPT-5.4/5.5：上下文窗口和最大输出 token 修正
		if (candidate.provider === "openai" && (candidate.id === "gpt-5.4" || candidate.id === "gpt-5.5")) {
			candidate.contextWindow = 272000;
			candidate.maxTokens = 128000;
		}
	}

	// =========================================================================
	// 第二步：补充 models.dev 中缺失的模型
	// =========================================================================
	// models.dev 可能还没收录最新发布的模型，这里手动补充。

	// 补充 Claude Opus 4.6
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-opus-4-6")) {
		allModels.push({
			id: "claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// 补充 Claude Opus 4.7
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-opus-4-7")) {
		allModels.push({
			id: "claude-opus-4-7",
			name: "Claude Opus 4.7",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// 补充 Claude Sonnet 4.6
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-sonnet-4-6")) {
		allModels.push({
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 3,
				output: 15,
				cacheRead: 0.3,
				cacheWrite: 3.75,
			},
			contextWindow: 1000000,
			maxTokens: 64000,
		});
	}

	// 补充 GPT-5 系列缺失模型
	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5-chat-latest")) {
		allModels.push({
			id: "gpt-5-chat-latest",
			name: "GPT-5 Chat Latest",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		});
	}

	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5.1-codex")) {
		allModels.push({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 5,
				cacheRead: 0.125,
				cacheWrite: 1.25,
			},
			contextWindow: 400000,
			maxTokens: 128000,
		});
	}

	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5.1-codex-max")) {
		allModels.push({
			id: "gpt-5.1-codex-max",
			name: "GPT-5.1 Codex Max",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 400000,
			maxTokens: 128000,
		});
	}

	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5.3-codex-spark")) {
		allModels.push({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		});
	}

	if (!allModels.some((m) => m.provider === "openai" && m.id === "gpt-5.4")) {
		allModels.push({
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 2.5,
				output: 15,
				cacheRead: 0.25,
				cacheWrite: 0,
			},
			contextWindow: 272000,
			maxTokens: 128000,
		});
	}

	// =========================================================================
	// 第三步：生成 Azure OpenAI 模型
	// =========================================================================
	// Azure OpenAI 复用 OpenAI 的模型列表，但使用不同的 api 和 provider。
	// baseUrl 留空，由用户自己配置（Azure 的 endpoint 因部署而异）。
	const azureOpenAiModels: Model<Api>[] = allModels
		.filter((model) => model.provider === "openai" && model.api === "openai-responses")
		.map((model) => ({
			...model,
			api: "azure-openai-responses" as const,    // 新的协议名
			provider: "azure-openai-responses",          // 新的 provider 名
			baseUrl: "",                                  // 用户自己配置
		}));
	allModels.push(...azureOpenAiModels);

	// =========================================================================
	// 第四步：应用推理级别元数据
	// =========================================================================
	for (const model of allModels) {
		applyThinkingLevelMetadata(model);
	}

	// =========================================================================
	// 第五步：按 provider 分组、按 model ID 去重
	// =========================================================================
	const providers: Record<string, Record<string, Model<any>>> = {};
	for (const model of allModels) {
		if (!providers[model.provider]) {
			providers[model.provider] = {};
		}
		// 用 model ID 作为 key 自动去重
		// 先添加的优先（models.dev 的数据优先于 OpenRouter）
		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model;
		}
	}

	// =========================================================================
	// 第六步：生成 models.generated.ts 文件
	// =========================================================================
	let output = `// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update

import type { Model } from "./types.ts";

export const MODELS = {
`;

	// 按 provider 名排序（保证输出确定性，避免 git diff 抖动）
	const sortedProviderIds = Object.keys(providers).sort();
	for (const providerId of sortedProviderIds) {
		const models = providers[providerId];
		output += `\t${JSON.stringify(providerId)}: {\n`;

		// 按模型 ID 排序
		const sortedModelIds = Object.keys(models).sort();
		for (const modelId of sortedModelIds) {
			const model = models[modelId];
			output += `\t\t"${model.id}": {\n`;
			output += `\t\t\tid: "${model.id}",\n`;
			output += `\t\t\tname: "${model.name}",\n`;
			output += `\t\t\tapi: "${model.api}",\n`;
			output += `\t\t\tprovider: "${model.provider}",\n`;
			if (model.baseUrl !== undefined) {
				output += `\t\t\tbaseUrl: "${model.baseUrl}",\n`;
			}
			if (model.headers) {
				output += `\t\t\theaders: ${JSON.stringify(model.headers)},\n`;
			}
			if (model.compat) {
				output += `			compat: ${JSON.stringify(model.compat)},
`;
			}
			output += `\t\t\treasoning: ${model.reasoning},\n`;
			if (model.thinkingLevelMap) {
				output += `\t\t\tthinkingLevelMap: ${JSON.stringify(model.thinkingLevelMap)},\n`;
			}
			output += `\t\t\tinput: [${model.input.map(i => `"${i}"`).join(", ")}],\n`;
			output += `\t\t\tcost: {\n`;
			output += `\t\t\t\tinput: ${model.cost.input},\n`;
			output += `\t\t\t\toutput: ${model.cost.output},\n`;
			output += `\t\t\t\tcacheRead: ${model.cost.cacheRead},\n`;
			output += `\t\t\t\tcacheWrite: ${model.cost.cacheWrite},\n`;
			output += `\t\t\t},\n`;
			output += `\t\t\tcontextWindow: ${model.contextWindow},\n`;
			output += `\t\t\tmaxTokens: ${model.maxTokens},\n`;
			output += `\t\t} satisfies Model<"${model.api}">,\n`;
		}

		output += `\t},\n`;
	}

	output += `} as const;
`;

	// 写入文件
	writeFileSync(join(packageRoot, "src/models.generated.ts"), output);
	console.log("Generated src/models.generated.ts");

	// 打印统计信息
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	console.log(`\nModel Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(providers)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`);
	}
}

// 运行生成器，捕获错误并打印
generateModels().catch(console.error);
