/**
 * 模型注册表（Model Registry）—— 管理内置模型与自定义模型，提供 API key 解析。
 *
 * 文件定位：coding-agent 的模型管理层，负责从 pi-ai 内置模型和 models.json 自定义配置中
 * 加载所有可用模型，处理模型覆盖（override）合并，以及通过 AuthStorage 解析 API key 和请求头。
 *
 * 提供：
 * - ModelRegistry 类：模型的注册、查询、刷新，以及请求认证信息的解析
 * - ProviderConfigInput 接口：扩展注册 provider 的输入格式
 * - 自定义模型/覆盖的 JSON Schema 定义（通过 typebox 编译校验）
 * - models.json 配置文件的加载、校验、解析流程
 *
 * 调用链路：
 * - 被 agent 启动时创建，加载内置 + 自定义模型
 * - 被 model-resolver.ts 调用，查询可用模型列表、查找特定模型
 * - 被扩展（extensions）通过 registerProvider() 动态注册 provider 和模型
 * - 调用 resolve-config-value.ts 解析 apiKey / headers 中的环境变量和 shell 命令
 * - 调用 auth-storage.ts 查询已存储的认证状态
 */

import {
	type AnthropicMessagesCompat,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	getModels,
	getProviders,
	type KnownProvider,
	type Model,
	type OpenAICompletionsCompat,
	type OpenAIResponsesCompat,
	registerApiProvider,
	resetApiProviders,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import type { AuthStatus, AuthStorage } from "./auth-storage.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";
import {
	clearConfigValueCache,
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

// OpenRouter 路由偏好配置的 Schema
const PercentileCutoffsSchema = Type.Object({
	p50: Type.Optional(Type.Number()),
	p75: Type.Optional(Type.Number()),
	p90: Type.Optional(Type.Number()),
	p99: Type.Optional(Type.Number()),
});

const OpenRouterRoutingSchema = Type.Object({
	allow_fallbacks: Type.Optional(Type.Boolean()),
	require_parameters: Type.Optional(Type.Boolean()),
	data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
	zdr: Type.Optional(Type.Boolean()),
	enforce_distillable_text: Type.Optional(Type.Boolean()),
	order: Type.Optional(Type.Array(Type.String())),
	only: Type.Optional(Type.Array(Type.String())),
	ignore: Type.Optional(Type.Array(Type.String())),
	quantizations: Type.Optional(Type.Array(Type.String())),
	sort: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Object({
				by: Type.Optional(Type.String()),
				partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
		]),
	),
	max_price: Type.Optional(
		Type.Object({
			prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		}),
	),
	preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
	preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

// Vercel AI Gateway 路由偏好配置的 Schema
const VercelGatewayRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

// 思考级别支持及 provider 特定值的 Schema
const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
const ThinkingLevelMapSchema = Type.Object({
	off: Type.Optional(ThinkingLevelMapValueSchema),
	minimal: Type.Optional(ThinkingLevelMapValueSchema),
	low: Type.Optional(ThinkingLevelMapValueSchema),
	medium: Type.Optional(ThinkingLevelMapValueSchema),
	high: Type.Optional(ThinkingLevelMapValueSchema),
	xhigh: Type.Optional(ThinkingLevelMapValueSchema),
});

const OpenAICompletionsCompatSchema = Type.Object({
	supportsStore: Type.Optional(Type.Boolean()),
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	supportsReasoningEffort: Type.Optional(Type.Boolean()),
	supportsUsageInStreaming: Type.Optional(Type.Boolean()),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
	requiresToolResultName: Type.Optional(Type.Boolean()),
	requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
	requiresThinkingAsText: Type.Optional(Type.Boolean()),
	requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
	thinkingFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openrouter"),
			Type.Literal("qwen"),
			Type.Literal("qwen-chat-template"),
		]),
	),
	cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
	openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
	vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const OpenAIResponsesCompatSchema = Type.Object({
	sendSessionIdHeader: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const AnthropicMessagesCompatSchema = Type.Object({
	supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	supportsCacheControlOnTools: Type.Optional(Type.Boolean()),
	forceAdaptiveThinking: Type.Optional(Type.Boolean()),
});

const ProviderCompatSchema = Type.Union([
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	AnthropicMessagesCompatSchema,
]);

// 自定义模型定义的 Schema
// 大部分字段为可选，本地模型（Ollama、LM Studio 等）有合理的默认值
const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({
			input: Type.Number(),
			output: Type.Number(),
			cacheRead: Type.Number(),
			cacheWrite: Type.Number(),
		}),
	),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
});

// 每模型覆盖配置的 Schema（所有字段可选，与内置模型合并）
const ModelOverrideSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({
			input: Type.Optional(Type.Number()),
			output: Type.Optional(Type.Number()),
			cacheRead: Type.Optional(Type.Number()),
			cacheWrite: Type.Optional(Type.Number()),
		}),
	),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
});

type ModelOverride = Static<typeof ModelOverrideSchema>;

const ProviderConfigSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	apiKey: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
	authHeader: Type.Optional(Type.Boolean()),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

const ModelsConfigSchema = Type.Object({
	providers: Type.Record(Type.String(), ProviderConfigSchema),
});

const validateModelsConfig = Compile(ModelsConfigSchema);

type ModelsConfig = Static<typeof ModelsConfigSchema>;

/** 格式化校验错误的路径信息，用于生成友好的错误提示 */
function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

/** 去除 JSON 中的 `//` 行注释和尾部逗号，不影响字符串字面量中的内容 */
function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

/** Provider 覆盖配置（baseUrl、compat），不包含请求认证/头信息 */
interface ProviderOverride {
	baseUrl?: string;
	compat?: Model<Api>["compat"];
}

/** Provider 请求认证配置（apiKey、headers、是否使用 auth header） */
interface ProviderRequestConfig {
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
}

/** 请求认证解析结果：成功时包含 apiKey 和 headers，失败时包含错误信息 */
export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: Record<string, string>;
	  }
	| {
			ok: false;
			error: string;
	  };

/** 从 models.json 加载自定义模型的结果 */
interface CustomModelsResult {
	models: Model<Api>[];
	/** 对内置模型有 baseUrl/headers/apiKey 覆盖的 provider 配置 */
	overrides: Map<string, ProviderOverride>;
	/** 每模型覆盖配置：provider -> modelId -> override */
	modelOverrides: Map<string, Map<string, ModelOverride>>;
	error: string | undefined;
}

/** 创建空的自定义模型结果（用于加载失败或文件不存在时） */
function emptyCustomModelsResult(error?: string): CustomModelsResult {
	return { models: [], overrides: new Map(), modelOverrides: new Map(), error };
}

/** 合并 compat 配置：将覆盖值合并到基础值之上，覆盖值中的字段优先 */
function mergeCompat(
	baseCompat: Model<Api>["compat"],
	overrideCompat: ModelOverride["compat"],
): Model<Api>["compat"] | undefined {
	if (!overrideCompat) return baseCompat;

	const base = baseCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat | undefined;
	const override = overrideCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;
	const merged = { ...base, ...override } as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;

	return merged as Model<Api>["compat"];
}

/**
 * 深度合并模型覆盖配置到模型对象。
 * 对嵌套对象（cost、compat）执行合并而非整体替换。
 *
 * @param model - 基础模型对象
 * @param override - 覆盖配置
 * @returns 合并后的新模型对象
 */
function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	const result = { ...model };

	// 简单字段覆盖
	if (override.name !== undefined) result.name = override.name;
	if (override.reasoning !== undefined) result.reasoning = override.reasoning;
	if (override.thinkingLevelMap !== undefined) {
		result.thinkingLevelMap = { ...model.thinkingLevelMap, ...override.thinkingLevelMap };
	}
	if (override.input !== undefined) result.input = override.input as ("text" | "image")[];
	if (override.contextWindow !== undefined) result.contextWindow = override.contextWindow;
	if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;

	// 合并 cost（部分覆盖）
	if (override.cost) {
		result.cost = {
			input: override.cost.input ?? model.cost.input,
			output: override.cost.output ?? model.cost.output,
			cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
			cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
		};
	}

	// 深度合并 compat
	result.compat = mergeCompat(model.compat, override.compat);

	return result;
}

/** 清除配置值的命令缓存。导出用于测试。 */
export const clearApiKeyCache = clearConfigValueCache;

/**
 * 模型注册表——加载和管理模型，通过 AuthStorage 解析 API key。
 *
 * 主要职责：
 * 1. 加载 pi-ai 内置模型，应用 models.json 中的 provider/model 级覆盖
 * 2. 加载 models.json 中定义的自定义模型
 * 3. 支持扩展（extensions）动态注册/注销 provider
 * 4. 解析每个模型的 API key 和请求头（支持环境变量和 shell 命令）
 */
export class ModelRegistry {
	private models: Model<Api>[] = [];
	private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
	private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
	/** 已通过扩展注册的 provider 配置（用于 refresh 时重建） */
	private registeredProviders: Map<string, ProviderConfigInput> = new Map();
	private loadError: string | undefined = undefined;
	readonly authStorage: AuthStorage;
	/** models.json 文件路径，undefined 表示纯内存模式（不加载文件） */
	private modelsJsonPath: string | undefined;

	private constructor(authStorage: AuthStorage, modelsJsonPath: string | undefined) {
		this.authStorage = authStorage;
		this.modelsJsonPath = modelsJsonPath ? normalizePath(modelsJsonPath) : undefined;
		this.loadModels();
	}

	/** 创建 ModelRegistry 实例，加载 models.json 文件 */
	static create(authStorage: AuthStorage, modelsJsonPath: string = join(getAgentDir(), "models.json")): ModelRegistry {
		return new ModelRegistry(authStorage, modelsJsonPath);
	}

	/** 创建纯内存模式的 ModelRegistry（不加载 models.json，用于测试等场景） */
	static inMemory(authStorage: AuthStorage): ModelRegistry {
		return new ModelRegistry(authStorage, undefined);
	}

	/**
	 * 从磁盘重新加载模型（内置 + models.json 自定义）。
	 * 清除现有状态，重置 API provider 注册，然后重新加载并应用已注册的扩展配置。
	 *
	 * 定位：模型注册表的全量重建入口。
	 * 作用：在设置变更或 provider 注销后，重新构造内置模型、自定义模型和动态 provider 状态。
	 * 调用关系：被设置重载、provider 注销和外部显式刷新逻辑调用。
	 */
	refresh(): void {
		this.providerRequestConfigs.clear();
		this.modelRequestHeaders.clear();
		this.loadError = undefined;

		// 确保动态 API 注册从当前 provider 状态重建
		resetApiProviders();

		this.loadModels();

		for (const [providerName, config] of this.registeredProviders.entries()) {
			this.applyProviderConfig(providerName, config);
		}
	}

	/**
	 * 获取加载 models.json 时的错误信息（无错误时返回 undefined）。
	 */
	getError(): string | undefined {
		return this.loadError;
	}

	/**
	 * 加载当前应生效的完整模型列表。
	 *
	 * 定位：构造函数和 `refresh()` 的共享装载步骤。
	 * 作用：组合内置模型、自定义模型和覆盖配置，并把错误保存在注册表上。
	 * 调用关系：仅由本类内部调用。
	 */
	private loadModels(): void {
		// 从 models.json 加载自定义模型和覆盖配置
		const {
			models: customModels,
			overrides,
			modelOverrides,
			error,
		} = this.modelsJsonPath ? this.loadCustomModels(this.modelsJsonPath) : emptyCustomModelsResult();

		if (error) {
			this.loadError = error;
			// 即使自定义模型加载失败，仍保留内置模型
		}

		const builtInModels = this.loadBuiltInModels(overrides, modelOverrides);
		const combined = this.mergeCustomModels(builtInModels, customModels);

		this.models = combined;
	}

	/** 加载内置模型，并应用 provider/model 级别的覆盖配置 */
	private loadBuiltInModels(
		overrides: Map<string, ProviderOverride>,
		modelOverrides: Map<string, Map<string, ModelOverride>>,
	): Model<Api>[] {
		return getProviders().flatMap((provider) => {
			const models = getModels(provider as KnownProvider) as Model<Api>[];
			const providerOverride = overrides.get(provider);
			const perModelOverrides = modelOverrides.get(provider);

			return models.map((m) => {
				let model = m;

				// 应用 provider 级别的 baseUrl/headers/compat 覆盖
				if (providerOverride) {
					model = {
						...model,
						baseUrl: providerOverride.baseUrl ?? model.baseUrl,
						compat: mergeCompat(model.compat, providerOverride.compat),
					};
				}

				// 应用每模型覆盖
				const modelOverride = perModelOverrides?.get(m.id);
				if (modelOverride) {
					model = applyModelOverride(model, modelOverride);
				}

				return model;
			});
		});
	}

	/** 将自定义模型合并到内置列表中，按 provider+id 匹配（自定义模型优先） */
	private mergeCustomModels(builtInModels: Model<Api>[], customModels: Model<Api>[]): Model<Api>[] {
		const merged = [...builtInModels];
		for (const customModel of customModels) {
			const existingIndex = merged.findIndex((m) => m.provider === customModel.provider && m.id === customModel.id);
			if (existingIndex >= 0) {
				merged[existingIndex] = customModel;
			} else {
				merged.push(customModel);
			}
		}
		return merged;
	}

	/**
	 * 从 `models.json` 读取自定义模型与 provider 覆盖配置。
	 *
	 * 定位：磁盘配置装载入口。
	 * 作用：读取、去注释、校验 schema、执行业务校验，并抽取 provider/model 级覆盖信息。
	 * 调用关系：由 `loadModels()` 调用。
	 */
	private loadCustomModels(modelsJsonPath: string): CustomModelsResult {
		// 文件不存在时返回空结果
		if (!existsSync(modelsJsonPath)) {
			return emptyCustomModelsResult();
		}

		try {
			const content = readFileSync(modelsJsonPath, "utf-8");
			const parsed = JSON.parse(stripJsonComments(content)) as unknown;

			if (!validateModelsConfig.Check(parsed)) {
				const errors =
					validateModelsConfig
						.Errors(parsed)
						.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
						.join("\n") || "Unknown schema error";
				return emptyCustomModelsResult(`Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`);
			}

			const config = parsed as ModelsConfig;

			// 执行额外的业务校验（beyond schema validation）
			this.validateConfig(config);

			const overrides = new Map<string, ProviderOverride>();
			const modelOverrides = new Map<string, Map<string, ModelOverride>>();

			for (const [providerName, providerConfig] of Object.entries(config.providers)) {
				if (providerConfig.baseUrl || providerConfig.compat) {
					overrides.set(providerName, {
						baseUrl: providerConfig.baseUrl,
						compat: providerConfig.compat,
					});
				}

				this.storeProviderRequestConfig(providerName, providerConfig);

				if (providerConfig.modelOverrides) {
					modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
					for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides)) {
						this.storeModelHeaders(providerName, modelId, modelOverride.headers);
					}
				}
			}

			return { models: this.parseModels(config), overrides, modelOverrides, error: undefined };
		} catch (error) {
			if (error instanceof SyntaxError) {
				return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
			}
			return emptyCustomModelsResult(
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`,
			);
		}
	}

	private validateConfig(config: ModelsConfig): void {
		const builtInProviders = new Set<string>(getProviders());

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const isBuiltIn = builtInProviders.has(providerName);
			const hasProviderApi = !!providerConfig.api;
			const models = providerConfig.models ?? [];
			const hasModelOverrides =
				providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0;

			if (models.length === 0) {
				// 仅覆盖配置：需要 baseUrl、headers、compat、modelOverrides 或其组合
				if (!providerConfig.baseUrl && !providerConfig.headers && !providerConfig.compat && !hasModelOverrides) {
					throw new Error(
						`Provider ${providerName}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
					);
				}
			} else if (!isBuiltIn) {
				// 非内置 provider 的自定义模型需要提供 endpoint 和认证信息
				if (!providerConfig.baseUrl) {
					throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
				}
				if (!providerConfig.apiKey) {
					throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);
				}
			}
			// 内置 provider 的自定义模型：baseUrl/apiKey/api 可选，继承自内置模型
			// 认证信息来自环境变量或 auth storage

			for (const modelDef of models) {
				const hasModelApi = !!modelDef.api;

				if (!hasProviderApi && !hasModelApi && !isBuiltIn) {
					throw new Error(
						`Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
					);
				}
				// 内置 provider 的 api 可选——继承自内置模型

				if (!modelDef.id) throw new Error(`Provider ${providerName}: model missing "id"`);
				// 仅在提供时校验 contextWindow/maxTokens（它们有默认值）
				if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0)
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
				if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0)
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
			}
		}
	}

	/**
	 * 把通过校验的 `models.json` 配置转成运行时模型对象。
	 *
	 * 定位：自定义模型构建步骤。
	 * 作用：解析 provider / model 级默认值，并为每个模型补齐缺省字段。
	 * 调用关系：由 `loadCustomModels()` 在校验完成后调用。
	 */
	private parseModels(config: ModelsConfig): Model<Api>[] {
		const models: Model<Api>[] = [];
		const builtInProviders = new Set<string>(getProviders());

		// 缓存每个 provider 的内置默认值（api、baseUrl），从第一个模型中提取
		const builtInDefaultsCache = new Map<string, { api: string; baseUrl: string }>();
		const getBuiltInDefaults = (providerName: string): { api: string; baseUrl: string } | undefined => {
			if (!builtInProviders.has(providerName)) return undefined;
			if (builtInDefaultsCache.has(providerName)) return builtInDefaultsCache.get(providerName);
			const builtIn = getModels(providerName as KnownProvider) as Model<Api>[];
			if (builtIn.length === 0) return undefined;
			const defaults = { api: builtIn[0].api, baseUrl: builtIn[0].baseUrl };
			builtInDefaultsCache.set(providerName, defaults);
			return defaults;
		};

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // 仅覆盖配置，无自定义模型

			const builtInDefaults = getBuiltInDefaults(providerName);

			for (const modelDef of modelDefs) {
				const api = modelDef.api ?? providerConfig.api ?? builtInDefaults?.api;
				if (!api) continue;

				const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl ?? builtInDefaults?.baseUrl;
				if (!baseUrl) continue;

				const compat = mergeCompat(providerConfig.compat, modelDef.compat);
				this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

				const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				models.push({
					id: modelDef.id,
					name: modelDef.name ?? modelDef.id,
					api: api as Api,
					provider: providerName,
					baseUrl,
					reasoning: modelDef.reasoning ?? false,
					thinkingLevelMap: modelDef.thinkingLevelMap,
					input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
					cost: modelDef.cost ?? defaultCost,
					contextWindow: modelDef.contextWindow ?? 128000,
					maxTokens: modelDef.maxTokens ?? 16384,
					headers: undefined,
					compat,
				} as Model<Api>);
			}
		}

		return models;
	}

	/**
	 * 获取所有模型（内置 + 自定义）。
	 * 如果 models.json 有错误，仅返回内置模型。
	 */
	getAll(): Model<Api>[] {
		return this.models;
	}

	/**
	 * 获取已配置认证信息的模型列表。
	 * 这是快速检查，不会刷新已存储的凭据。
	 */
	getAvailable(): Model<Api>[] {
		return this.models.filter((m) => this.hasConfiguredAuth(m));
	}

	/**
	 * 按 provider 和 ID 查找模型。
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.models.find((m) => m.provider === provider && m.id === modelId);
	}

	/**
	 * 检查模型是否已配置认证信息。
	 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		return (
			this.authStorage.hasAuth(model.provider) ||
			this.providerRequestConfigs.get(model.provider)?.apiKey !== undefined
		);
	}

	private getModelRequestKey(provider: string, modelId: string): string {
		return `${provider}:${modelId}`;
	}

	private storeProviderRequestConfig(
		providerName: string,
		config: {
			apiKey?: string;
			headers?: Record<string, string>;
			authHeader?: boolean;
		},
	): void {
		if (!config.apiKey && !config.headers && !config.authHeader) {
			return;
		}

		this.providerRequestConfigs.set(providerName, {
			apiKey: config.apiKey,
			headers: config.headers,
			authHeader: config.authHeader,
		});
	}

	private storeModelHeaders(providerName: string, modelId: string, headers?: Record<string, string>): void {
		const key = this.getModelRequestKey(providerName, modelId);
		if (!headers || Object.keys(headers).length === 0) {
			this.modelRequestHeaders.delete(key);
			return;
		}
		this.modelRequestHeaders.set(key, headers);
	}

	/**
	 * 获取模型的 API key 和请求头。
	 * 解析优先级：authStorage > models.json 中的 apiKey 配置
	 * 请求头合并优先级：model.headers < providerHeaders < modelHeaders
	 *
	 * 定位：模型请求发送前的认证解析出口。
	 * 作用：综合 auth storage、provider 配置和模型级请求头，生成可直接发请求的认证信息。
	 * 调用关系：被 `agent-session.ts`、模型探测和其他发起模型请求的流程调用。
	 */
	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const providerConfig = this.providerRequestConfigs.get(model.provider);
			const apiKeyFromAuthStorage = await this.authStorage.getApiKey(model.provider, { includeFallback: false });
			const apiKey =
				apiKeyFromAuthStorage ??
				(providerConfig?.apiKey
					? resolveConfigValueOrThrow(providerConfig.apiKey, `API key for provider "${model.provider}"`)
					: undefined);

			const providerHeaders = resolveHeadersOrThrow(providerConfig?.headers, `provider "${model.provider}"`);
			const modelHeaders = resolveHeadersOrThrow(
				this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)),
				`model "${model.provider}/${model.id}"`,
			);

			// 头部按模型内置 < provider 配置 < 模型覆盖的顺序合并。
			let headers =
				model.headers || providerHeaders || modelHeaders
					? { ...model.headers, ...providerHeaders, ...modelHeaders }
					: undefined;

			if (providerConfig?.authHeader) {
				if (!apiKey) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				headers = { ...headers, Authorization: `Bearer ${apiKey}` };
			}

			return {
				ok: true,
				apiKey,
				headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * 获取 provider 的认证状态，包含 models.json 中配置的请求认证信息。
	 * 注意：不会执行命令类型的配置值（仅检查是否配置）。
	 */
	getProviderAuthStatus(provider: string): AuthStatus {
		const authStatus = this.authStorage.getAuthStatus(provider);
		if (authStatus.source) {
			return authStatus;
		}

		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		if (!providerApiKey) {
			return authStatus;
		}

		if (providerApiKey.startsWith("!")) {
			return { configured: true, source: "models_json_command" };
		}

		if (process.env[providerApiKey]) {
			return { configured: true, source: "environment", label: providerApiKey };
		}

		return { configured: true, source: "models_json_key" };
	}

	/**
	 * 获取 provider 的显示名称。
	 */
	getProviderDisplayName(provider: string): string {
		const registeredProvider = this.registeredProviders.get(provider);

		return registeredProvider?.name ?? BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ?? provider;
	}

	/**
	 * 获取 provider 的 API key。
	 * 优先从 authStorage 获取，不存在时尝试从 models.json 配置解析。
	 */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		const apiKey = await this.authStorage.getApiKey(provider, { includeFallback: false });
		if (apiKey !== undefined) {
			return apiKey;
		}

		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		return providerApiKey ? resolveConfigValueUncached(providerApiKey) : undefined;
	}

	/**
	 * 检查模型是否使用订阅式的存储认证。
	 */
	isUsingSubscriptionAuth(model: Model<Api>): boolean {
		void model;
		return false;
	}

	/**
	 * 通过扩展动态注册一个 provider。
	 *
	 * 如果 provider 包含 models：替换该 provider 的所有现有模型。
	 * 如果 provider 仅有 baseUrl/headers：覆盖现有模型的 URL。
	 * 已存储的认证配置仍由 AuthStorage 和 /login 管理。
	 *
	 * 定位：扩展系统动态接入模型 provider 的主入口。
	 * 作用：校验输入、把 provider 应用到当前注册表，并保存到可重建的注册列表中。
	 * 调用关系：由扩展运行时通过 `registerProvider()` 调用。
	 */
	registerProvider(providerName: string, config: ProviderConfigInput): void {
		this.validateProviderConfig(providerName, config);
		this.applyProviderConfig(providerName, config);
		this.upsertRegisteredProvider(providerName, config);
	}

	/**
	 * 注销之前注册的 provider。
	 *
	 * 从注册表中移除该 provider，并从磁盘重新加载模型，
	 * 使被此 provider 覆盖的内置模型恢复原始状态。
	 * 同时重置动态 API 流注册，然后重新应用剩余的动态 provider。
	 * 如果该 provider 从未注册过，则无操作。
	 */
	unregisterProvider(providerName: string): void {
		if (!this.registeredProviders.has(providerName)) return;
		this.registeredProviders.delete(providerName);
		this.refresh();
	}

	/**
	 * 将 provider 配置插入或更新到已注册列表中。
	 * 如果 provider 已注册，传入配置中已定义的字段覆盖现有值，undefined 字段保留原有值。
	 * 如果 provider 未注册，直接存储传入的配置。
	 */
	private upsertRegisteredProvider(providerName: string, config: ProviderConfigInput): void {
		const existing = this.registeredProviders.get(providerName);
		if (!existing) {
			this.registeredProviders.set(providerName, config);
			return;
		}
		for (const k of Object.keys(config) as (keyof ProviderConfigInput)[]) {
			if (config[k] !== undefined) {
				(existing as Record<string, unknown>)[k] = config[k];
			}
		}
	}

	private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}

		if (!config.models || config.models.length === 0) {
			return;
		}

		if (!config.baseUrl) {
			throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
		}
		if (!config.apiKey) {
			throw new Error(`Provider ${providerName}: "apiKey" is required when defining models.`);
		}

		for (const modelDef of config.models) {
			const api = modelDef.api || config.api;
			if (!api) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
			}
		}
	}

	/**
	 * 将单个 provider 配置实际应用到当前注册表。
	 *
	 * 定位：动态 provider 注册与 refresh 重建时的共享落地逻辑。
	 * 作用：注册 API provider、保存认证配置，并根据配置更新模型列表或覆盖 baseUrl。
	 * 调用关系：被 `registerProvider()` 和 `refresh()` 调用。
	 */
	private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
		if (config.streamSimple) {
			const streamSimple = config.streamSimple;
			registerApiProvider(
				{
					api: config.api!,
					stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
					streamSimple,
				},
				`provider:${providerName}`,
			);
		}

		this.storeProviderRequestConfig(providerName, config);

		if (config.models && config.models.length > 0) {
			// 完全替换：移除该 provider 的所有现有模型
			this.models = this.models.filter((m) => m.provider !== providerName);

			// 解析并添加新模型
			for (const modelDef of config.models) {
				const api = modelDef.api || config.api;
				this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

				this.models.push({
					id: modelDef.id,
					name: modelDef.name,
					api: api as Api,
					provider: providerName,
					baseUrl: modelDef.baseUrl ?? config.baseUrl!,
					reasoning: modelDef.reasoning,
					thinkingLevelMap: modelDef.thinkingLevelMap,
					input: modelDef.input as ("text" | "image")[],
					cost: modelDef.cost,
					contextWindow: modelDef.contextWindow,
					maxTokens: modelDef.maxTokens,
					headers: undefined,
					compat: modelDef.compat,
				} as Model<Api>);
			}
		} else if (config.baseUrl || config.headers) {
			// 仅覆盖模式：更新现有模型的 baseUrl，请求头按请求时解析
			this.models = this.models.map((m) => {
				if (m.provider !== providerName) return m;
				return {
					...m,
					baseUrl: config.baseUrl ?? m.baseUrl,
				};
			});
		}
	}
}

/**
 * registerProvider API 的输入类型。
 */
export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
		input: ("text" | "image")[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
	}>;
}
