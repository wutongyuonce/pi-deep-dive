import { MODELS } from "./models.generated.ts";
import type { Api, KnownProvider, Model, ModelThinkingLevel, Usage } from "./types.ts";

/**
 * 文本模型注册表。
 *
 * 结构：provider 名 → (模型 ID → 模型元信息)
 * 例如："openai" → "gpt-4o" → Model<"openai-responses">
 *
 * 模块加载时从 models.generated.ts 自动初始化。
 */
const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// 模块加载时，把 MODELS 静态数据转成 Map 结构注册到注册表。
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

/**
 * 从 MODELS 静态类型中推断指定 provider + modelId 对应的 API 协议名。
 *
 * 例如：ModelApi<"openai", "gpt-4o"> → "openai-responses"
 * 这样 getModel() 的返回类型能自动携带正确的 API 泛型，
 * 下游 stream() 调用时可以做类型检查。
 */
type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

/**
 * 获取指定 provider 和模型 ID 的文本模型元信息。
 *
 * @example
 * ```typescript
 * const model = getModel("openai", "gpt-4o");
 * // model.api 自动推断为 "openai-responses"
 * streamSimple(model, context); // 类型安全
 * ```
 */
export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

/**
 * 获取所有已注册的文本服务提供商列表。
 */
export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

/**
 * 获取指定提供商下的所有文本模型列表。
 */
export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

/**
 * 根据模型单价和 token 用量计算费用。
 *
 * 计费公式：费用 = (单价 / 1_000_000) * token 数
 * 单价单位是"美元/百万 token"，存储在 model.cost 中。
 *
 * 直接修改传入的 usage.cost 对象（副作用）。
 */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/** 所有推理级别的有序列表（从低到高）。 */
const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * 获取模型支持的推理级别列表。
 *
 * 不支持推理的模型只返回 ["off"]。
 * 支持推理的模型返回所有可用级别（排除 thinkingLevelMap 中标记为 null 的）。
 */
export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false; // 显式标记为不支持
		if (level === "xhigh") return mapped !== undefined; // xhigh 需要显式映射
		return true;
	});
}

/**
 * 把请求的推理级别"钳位"到模型实际支持的最近级别。
 *
 * 策略：优先向上找更高级别，找不到再向下找更低级别。
 * 例如：请求 "high" 但模型只支持 ["off", "medium"] → 返回 "medium"
 */
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	// 向上查找：优先选择更高级别
	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	// 向下查找：选择更低级别
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * 比较两个模型是否相同（通过 id + provider 判断）。
 * 任一模型为 null/undefined 时返回 false。
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
