/**
 * provider / model 运行时管理层。
 *
 * 文件定位：`pi-ai` 的核心运行时抽象之一，负责管理 provider 集合、模型目录、认证解析及请求分发。
 *
 * 核心职责：
 * - 定义 `Provider`、`Models` 等核心接口
 * - 提供 `createModels()` 创建可变运行时集合
 * - 提供 `createProvider()` 将模型列表、auth 和 API 实现组装成统一 provider
 * - 统一计算 token 成本与 thinking level 映射
 *
 * 典型调用链：
 *   createModels() → ModelsImpl → setProvider(createProvider(...)) → stream()/complete() → applyAuth() → Provider.stream()
 */

import { lazyStream } from "./api/lazy.ts";
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ModelCostRates,
	ModelThinkingLevel,
	ProviderHeaders,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
	Usage,
} from "./types.ts";

export { type AuthModel, ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";

/**
 * Provider 封装 AI 服务提供者的标识、认证、模型目录和流式能力，是 `Models` 集合的基本管理单元。
 *
 * `TApi` 允许具体 provider 工厂声明其模型使用的 API 协议
 * （如 `openaiProvider(): Provider<"openai-responses" | "openai-completions">`），
 * 为直接调用工厂的用户提供类型化模型列表。在 `Models`
 * 集合内部，provider 以 `Provider<Api>` 持有。
 *
 * 被谁调用：`ModelsImpl` 持有并管理 Provider 实例；Provider 工厂函数返回该类型。
 * 调用了谁：依赖 `ProviderAuth` 完成认证解析；依赖 `ProviderStreams` 完成流式分发。
 */
export interface Provider<TApi extends Api = Api> {
	readonly id: string;
	readonly name: string;

	readonly baseUrl?: string;
	readonly headers?: ProviderHeaders;

	/**
	 * 声明 provider 的认证方式与解析逻辑。每个 provider 都必须有认证语义——
	 * 即使只使用环境变量、AWS profile、ADC 等环境凭证，
	 * 或通过 keyless 本地服务接入的 provider，也需提供 `apiKey` 认证，
	 * 其 `resolve()` 报告 provider 是否已配置。
	 *
	 * `Models.getAuth()` 在 provider 未配置时返回 undefined。
	 */
	readonly auth: ProviderAuth;

	/**
	 * 同步获取当前已知的模型列表。
	 * 静态 provider 直接返回内置目录；动态 provider 返回最近一次 `refreshModels()` 后的列表（首次 refresh 前为空）。
	 *
	 * 约束：不得抛出异常；`Models` 将抛异常的 provider 视为无模型。
	 */
	getModels(): readonly Model<TApi>[];

	/**
	 * 动态 provider 专用：拉取并更新模型列表。无副作用的模型发现（不涉及下载或加载）。
	 * 并发调用共享同一个进行中的请求（去重）。可能 reject（网络错误，失败时列表保留在上次已知状态，后续可重试）。
	 *
	 * 被谁调用：`ModelsImpl.refresh()`。
	 */
	refreshModels?(): Promise<void>;

	/**
	 * 完整参数流式调用，向模型发送请求并返回助手消息事件流。
	 * 被谁调用：`ModelsImpl.stream()` 在解析 auth 后委托调用。
	 */
	stream<T extends TApi>(
		model: Model<T>,
		context: Context,
		options?: ApiStreamOptions<T>,
	): AssistantMessageEventStream;

	/**
	 * 简化参数流式调用，使用 `SimpleStreamOptions`（含 reasoning 档位）进行流式请求。
	 * 被谁调用：`ModelsImpl.streamSimple()`。
	 */
	streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/**
 * 应用层与 provider 层之间的协调层，解析认证并将每个请求委托给拥有该模型的 provider。
 *
 * 被谁调用：`compat.ts` 兼容层、CLI 工具、应用层代码。
 * 调用了谁：`resolveProviderAuth()`（认证解析）、`Provider.stream()`（流式分发）。
 */
export interface Models {
	/** 同步返回当前集合中的所有 provider 实例。 */
	getProviders(): readonly Provider[];

	/** 按 id 查找单个 provider，未找到返回 undefined。 */
	getProvider(id: string): Provider | undefined;

	/**
	 * 按 provider id 过滤或返回全部已知模型。尽力而为：`getModels()` 抛异常的 provider 不贡献模型。
	 * 调用了谁：`Provider.getModels()`。
	 */
	getModels(provider?: string): readonly Model<Api>[];

	/**
	 * 在给定 provider 的已知模型中查找匹配 id 的模型。
	 * 动态模型列表的类型为 `Model<Api>`；可通过 `hasApi()` 类型守卫收窄。
	 * 调用了谁：`Provider.getModels()`。
	 */
	getModel(provider: string, id: string): Model<Api> | undefined;

	/**
	 * 要求动态 provider 重新获取模型列表。指定 provider id 时，该 provider 拉取失败则 reject 并抛出
	 * `ModelsError("model_source")`；不指定则并发刷新所有 provider（尽力而为）。静态 provider 为无操作。
	 * 调用了谁：`Provider.refreshModels()`。
	 */
	refresh(provider?: string): Promise<void>;

	/**
	 * 为模型解析请求认证，包含用于状态 UI 的来源标签。provider 未知或未配置时返回
	 * `undefined`。token 刷新失败时 reject `ModelsError("oauth")`
	 * （凭证保留供重试，重新登录可修复）；api-key 或凭证存储失败时 reject `ModelsError("auth")`。
	 * 被谁调用：`ModelsImpl.applyAuth()` 每次流式请求前。
	 * 调用了谁：`resolveProviderAuth()`。
	 */
	getAuth(model: Model<Api>): Promise<AuthResult | undefined>;

	/**
	 * 完整参数流式入口：解析认证后将请求分发给模型所属的 provider。
	 * 调用了谁：`applyAuth()` → `Provider.stream()`。
	 */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): AssistantMessageEventStream;

	/**
	 * 完整参数一次性调用：发起流式请求并等待 `AssistantMessage` 结果。
	 * 调用了谁：`stream()` → `AssistantMessageEventStream.result()`。
	 */
	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): Promise<AssistantMessage>;

	/**
	 * 简化参数流式入口，使用 `SimpleStreamOptions` 进行流式请求。
	 * 调用了谁：`applyAuth()` → `Provider.streamSimple()`。
	 */
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;

	/**
	 * 简化参数一次性调用：使用简化参数发起流式请求并等待完整结果。
	 * 调用了谁：`streamSimple()` → `AssistantMessageEventStream.result()`。
	 */
	completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
}

/**
 * `Models` 的可变扩展，允许运行时动态添加、删除、清空 provider。
 * 被谁调用：`createModels()` 工厂返回此接口。
 */
export interface MutableModels extends Models {
	/** 按 provider.id 新增或替换。Provider id 全局唯一。 */
	setProvider(provider: Provider): void;
	/** 按 id 移除一个 provider。 */
	deleteProvider(id: string): void;
	/** 清空所有已注册的 provider。 */
	clearProviders(): void;
}

/**
 * `createModels()` 的可选配置参数，允许外部注入自定义凭证存储和认证上下文。
 */
export interface CreateModelsOptions {
	/** 凭证存储实现，默认使用 `InMemoryCredentialStore`。 */
	credentials?: CredentialStore;
	/** 认证上下文，默认使用 `defaultProviderAuthContext()`。 */
	authContext?: AuthContext;
}

/**
 * provider 运行时集合的核心实现：管理 provider 注册表、凭证存储、认证解析，
 * 并提供 `stream` / `complete` / `streamSimple` / `completeSimple` 四个调用入口。
 *
 * 被谁调用：`createModels()` 创建实例。
 * 调用了谁：`resolveProviderAuth()`（认证解析）、`lazyStream()`（延迟流包装）、`Provider.stream()`（流式分发）。
 */
class ModelsImpl implements MutableModels {
	private providers = new Map<string, Provider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	/**
	 * 初始化 provider 集合、凭证存储和认证上下文。
	 * 被谁调用：`createModels()` 工厂函数。
	 */
	constructor(options?: CreateModelsOptions) {
		// 凭证存储默认使用内存实现；authContext 默认使用标准 provider 认证上下文。
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	/** 按 provider.id 新增或替换。 */
	setProvider(provider: Provider): void {
		this.providers.set(provider.id, provider);
	}

	/** 按 id 移除，不存在则无操作。 */
	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	/** 清空所有已注册的 provider。 */
	clearProviders(): void {
		this.providers.clear();
	}

	/** 以只读数组形式返回当前全部 provider 实例。 */
	getProviders(): readonly Provider[] {
		return Array.from(this.providers.values());
	}

	/** O(1) Map 查找，未找到返回 undefined。 */
	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	/**
	 * 同步读取模型列表。指定 provider 时只返回该 provider 的模型（不存在则返回空数组）；
	 * 不指定时返回所有 provider 的模型合集。单个 provider 抛出异常时被静默跳过。
	 */
	getModels(provider?: string): readonly Model<Api>[] {
		// 单 provider 查找：不存在则返回空；getModels 抛异常时也返回空。
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		// 全量遍历：逐个收集各 provider 的模型，异常 provider 跳过。
		const models: Model<Api>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// 尽力而为：行为异常的 provider 不贡献任何模型。
			}
		}
		return models;
	}

	/** 在指定 provider 的已知模型列表中按 model.id 查找。 */
	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	/**
	 * 刷新动态 provider 的模型列表。单 provider 刷新失败时包装为 `ModelsError("model_source")` 抛出；
	 * 全量刷新使用 `Promise.allSettled` 并发执行，任意单个失败不影响其他。
	 * 调用了谁：`Provider.refreshModels()`。
	 */
	async refresh(provider?: string): Promise<void> {
		// 单 provider 刷新：查找失败或静态 provider 直接返回；网络错误包装为 ModelsError 抛出。
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry?.refreshModels) return;
			try {
				await entry.refreshModels();
			} catch (error) {
				if (error instanceof ModelsError) throw error;
				throw new ModelsError("model_source", `Model refresh failed for ${provider}`, { cause: error });
			}
			return;
		}

		// 全量刷新：allSettled 兜底，任意单个 provider 失败不影响其他。
		await Promise.allSettled(Array.from(this.providers.values(), async (entry) => entry.refreshModels?.()));
	}

	/**
	 * 为模型解析请求认证。provider 未知返回 undefined；已知则委托 `resolveProviderAuth` 完成解析。
	 * 被谁调用：`applyAuth()` 每次流式请求前。
	 * 调用了谁：`resolveProviderAuth()`。
	 */
	async getAuth(model: Model<Api>): Promise<AuthResult | undefined> {
		const provider = this.providers.get(model.provider);
		if (!provider) return undefined;
		return resolveProviderAuth(provider, model, this.credentials, this.authContext);
	}

	/**
	 * 内部辅助：要求 provider 必须存在，否则抛出 `ModelsError`。
	 * 供 `applyAuth()` / `stream()` 等使用，确保后续操作不会在未知 provider 上执行。
	 */
	private requireProvider(model: Model<Api>): Provider {
		const provider = this.providers.get(model.provider);
		if (!provider) {
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		return provider;
	}

	/**
	 * `stream()` / `streamSimple()` 的前置步骤：解析 provider 认证，按字段级优先级合并
	 * apiKey / headers / env 到请求参数中。
	 *
	 * 调用了谁：`resolveProviderAuth()`、`requireProvider()`。
	 */
	private async applyAuth<TOptions extends StreamOptions>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<{ requestModel: Model<Api>; requestOptions: TOptions | undefined }> {
		// 阶段 1：解析 provider 认证，获取 apiKey / baseUrl / headers / env。
		const resolution = await resolveProviderAuth(
			this.requireProvider(model),
			model,
			this.credentials,
			this.authContext,
			{
				apiKey: options?.apiKey,
				env: options?.env,
			},
		);
		const auth = resolution?.auth;
		// 阶段 2：未认证时原样返回。
		if (!auth) return { requestModel: model, requestOptions: options };

		// 阶段 3：auth 返回的 baseUrl 优先于 model 内置的 baseUrl。
		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

		// 阶段 4：显式请求参数优先于 auth 解析结果。headers 和 env 按 key 级别浅合并（options 优先）。
		const apiKey = options?.apiKey ?? auth.apiKey;
		const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
		const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		const requestOptions = { ...options, apiKey, headers, env } as TOptions;

		return { requestModel, requestOptions };
	}

	/**
	 * 完整参数流式入口：通过 `lazyStream` 延迟触发，先解析 provider 和认证，再分发给 provider。
	 * 调用了谁：`lazyStream()`、`requireProvider()`、`applyAuth()` → `Provider.stream()`。
	 */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		// lazyStream 将异步的 provider 查找和 auth 注入包装进同步流接口中。
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options as StreamOptions | undefined);
			return provider.stream(requestModel as Model<TApi>, context, requestOptions as ApiStreamOptions<TApi>);
		});
	}

	/**
	 * 完整参数一次性调用：委托 `stream()` 发起请求并等待最终消息。
	 * 调用了谁：`stream()` → `AssistantMessageEventStream.result()`。
	 */
	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	/**
	 * 简化参数流式入口：通过 `lazyStream` 延迟触发，使用 `SimpleStreamOptions` 进行流式请求。
	 * 调用了谁：`lazyStream()`、`requireProvider()`、`applyAuth()` → `Provider.streamSimple()`。
	 */
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.streamSimple(requestModel, context, requestOptions);
		});
	}

	/**
	 * 简化参数一次性调用：委托 `streamSimple()` 发起请求并等待最终消息。
	 * 调用了谁：`streamSimple()` → `AssistantMessageEventStream.result()`。
	 */
	async completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}
}

/** 创建一个可变的 provider / model 运行时集合。 */
export function createModels(options?: CreateModelsOptions): MutableModels {
	return new ModelsImpl(options);
}

/**
 * `createProvider()` 的配置参数，提供构建 Provider 所需的所有元数据：
 * id、name、认证、模型列表、API 实现和可选的刷新逻辑。
 *
 * 被谁调用：`createProvider()` 接收此参数；各内置 provider 工厂构造此对象。
 */
export interface CreateProviderOptions<TApi extends Api = Api> {
	id: string;
	/** 显示名称，默认使用 `id`。 */
	name?: string;
	baseUrl?: string;
	headers?: ProviderHeaders;
	/** 必填 —— 每个 provider 都有认证语义，即使环境凭证型/keyless 的 provider 也不例外。 */
	auth: ProviderAuth;
	/** 初始模型列表（纯动态 provider 可为空）。 */
	models: readonly Model<TApi>[];
	/**
	 * 动态 provider 的模型刷新函数。成功时存储结果；并发调用共享同一个进行中的 fetch。
	 * 可能 reject：此时存储的列表保留在上次已知状态，rejection
	 * 由 `Models.refresh(provider)` 包装为 `ModelsError("model_source")` 向上传播，后续调用可重试。
	 */
	refreshModels?: () => Promise<readonly Model<TApi>[]>;
	/**
	 * API 流式实现。可以是单个 `ProviderStreams`（所有模型共享同一 API），
	 * 也可以是一个按 `model.api` 分组的 Map（用于混合 API 的 provider）。
	 */
	api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}

/**
 * 内置 provider 工厂和外部自定义 provider（如 `models.json`）的统一构建入口：
 * 接收 `CreateProviderOptions`，返回完整的 `Provider` 实例，封装模型存储、刷新去重和 API 分发。
 *
 * 被谁调用：各内置 provider 工厂函数、外部自定义 provider 加载逻辑。
 * 调用了谁：`lazyStream()`（错误流构造）。
 *
 * - 当 `api` 是单个实现时，provider 下所有模型共享同一套流式能力
 * - 当 `api` 是按 `model.api` 分组的 map 时，会在运行时按模型协议分发
 * - 若某个模型对应的 api 没有注册实现，则返回错误流
 */
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	let models = input.models;
	let inflightRefresh: Promise<void> | undefined;
	const refreshModels = input.refreshModels;
	// 判断 api 是单个 ProviderStreams 实现还是按 model.api 分组的 Map。
	const single =
		typeof (input.api as ProviderStreams).stream === "function" ? (input.api as ProviderStreams) : undefined;
	const byApi = single ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);

	/** 按模型的 api 字段查找对应的流式实现。 */
	const apiFor = (model: Model<Api>): ProviderStreams | undefined => single ?? byApi?.[model.api];

	/**
	 * 统一分发包装器：为每个 stream/streamSimple 调用查找对应的 API 实现，
	 * 找不到时返回错误流。
	 */
	const dispatch = (
		model: Model<Api>,
		run: (streams: ProviderStreams) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const streams = apiFor(model);
		if (!streams) {
			// 模型声明的 api 在当前 provider 下没有注册实现 → 返回错误流。
			return lazyStream(model, async () => {
				throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
			});
		}
		return run(streams);
	};

	return {
		id: input.id,
		name: input.name ?? input.id,
		baseUrl: input.baseUrl,
		headers: input.headers,
		auth: input.auth,
		getModels: () => models,
		refreshModels: refreshModels
			? () => {
					// inflight 去重：并发调用共享同一个 Promise，避免重复请求。
					inflightRefresh ??= (async () => {
						try {
							models = await refreshModels();
						} finally {
							// 无论成功失败，完成后清除 inflight 标记，允许下次重试。
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
		stream: (model, context, options) => dispatch(model, (streams) => streams.stream(model, context, options)),
		streamSimple: (model, context, options) =>
			dispatch(model, (streams) => streams.streamSimple(model, context, options)),
	};
}

/**
 * 运行时 API 类型守卫：检查模型的 `api` 字段是否匹配目标 API。
 * `getModel()` 返回 `Model<Api>`，通过此函数收窄为具体 API 类型以获取准确的 options 类型。
 *
 * 示例：
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options 获得完整类型推导
 * }
 * ```
 */
export function hasApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi> {
	return model.api === api;
}

/**
 * 计算单次请求的 token 费用：根据输入 token 规模匹配价格 tier，将结果写入 `usage.cost`。
 * Anthropic 的 1h cache write 按 2 倍 input 价格单独拆分计费。
 *
 * 被谁调用：各 provider API 实现层在流完成后调用。
 */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	// 先根据输入 token 规模匹配价格 tier：遍历所有 tier，选取最大匹配的阈值。
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates: ModelCostRates = model.cost;
	let matchedThreshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// Anthropic 对 1h cache write 按 2 倍 input 价格计费，需要单独拆分计算。
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/** 完整的 thinking 级别序列，从 off 到 max。 */
const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 获取当前模型支持的 thinking 级别列表：根据 `reasoning` 标志和 `thinkingLevelMap` 映射过滤。
 *
 * 被谁调用：`clampThinkingLevel()`、应用层 UI 渲染 thinking 选项。
 */
export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	// 模型不支持 reasoning 时只返回 "off"。
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		// null 映射表示该级别明确禁用。
		if (mapped === null) return false;
		// xhigh 和 max 级别需要显式映射才视为支持。
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		// 基础级别默认支持（"off" / "minimal" / "low" / "medium" / "high"）。
		return true;
	});
}

/**
 * 将用户请求的 thinking 级别夹紧到模型实际支持的范围内。
 * 若请求级别可用则直接返回；否则依次向更高、更低相邻档位回退。
 *
 * 被谁调用：provider API 实现层在构建请求参数时调用。
 * 调用了谁：`getSupportedThinkingLevels()`。
 */
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	// 快速路径：请求级别已支持。
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	// 向上回退：尝试更高档位。
	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	// 向下回退：尝试更低档位。
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	// 兜底：返回第一个可用级别，或 "off"。
	return availableLevels[0] ?? "off";
}

/**
 * 判断两个模型是否相等（比较 id 和 provider）。
 * 任一为 null/undefined 时返回 false。
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
