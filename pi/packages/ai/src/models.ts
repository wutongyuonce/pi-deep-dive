/**
 * 文本模型运行时与 Provider 装配中心。
 *
 * 文件定位：`pi-ai` 的文本侧运行时核心。它维护 Provider 集合，统一认证、动态模型目录、请求参数合并和流式分派。
 *
 * 典型调用链：
 *   builtinModels()/createModels() → setProvider() → stream()/complete()
 *   → applyAuth() → Provider.stream()/streamSimple() → API 实现
 */
import { lazyStream } from "./api/lazy.ts";
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthResult,
	AuthType,
	Credential,
	CredentialStore,
	ProviderAuth,
} from "./auth/types.ts";
import { InMemoryModelsStore, type ModelsStore, type ProviderModelsStore } from "./models-store.ts";
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

export { ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";

/** 传给动态 Provider `refreshModels()` 的受控刷新上下文。 */
export interface RefreshModelsContext {
	/** 当前有效凭证；联网前会先尝试刷新过期的 OAuth 凭证。 */
	credential?: Credential;
	/** 已限定到当前 provider ID 的持久化模型目录。 */
	store: ProviderModelsStore;
	/** 离线或仅恢复缓存时为 false。 */
	allowNetwork: boolean;
	/** 允许联网时跳过 provider 自己的时效判断并立即拉取。 */
	force?: boolean;
	signal?: AbortSignal;
}

export interface ModelsRefreshOptions {
	allowNetwork?: boolean;
	/** 允许联网时跳过 provider 自己的时效判断并立即拉取。 */
	force?: boolean;
	signal?: AbortSignal;
}

export interface ModelsRefreshResult {
	aborted: boolean;
	errors: ReadonlyMap<string, Error>;
}

export interface ModelsStreamTransforms {
	/** 在分派给 Provider 前变换已合并的 model/auth/request headers。 */
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}

export type ModelsApiStreamOptions<TApi extends Api> = ApiStreamOptions<TApi> & ModelsStreamTransforms;
export type ModelsSimpleStreamOptions = SimpleStreamOptions & ModelsStreamTransforms;

/**
 * Provider 是文本模型的具体运行时单元，持有标识、认证、模型目录和流式行为。
 *
 * `TApi` 让工厂声明其模型可能使用的协议；直接使用工厂时可获得更精确的模型/options 类型，加入 `Models` 集合后统一视为 `Provider<Api>`。
 */
export interface Provider<TApi extends Api = Api> {
	readonly id: string;
	readonly name: string;

	readonly baseUrl?: string;
	readonly headers?: ProviderHeaders;

	/**
	 * 必填的认证语义。即使只使用环境变量、AWS profile、ADC 或无 key 本地服务，也通过 `apiKey.resolve()` 报告是否已配置。
	 * 未配置时 `Models.getAuth()` 返回 undefined。
	 */
	readonly auth: ProviderAuth;

	/** 当前已知模型的同步快照；静态 provider 返回内置目录，动态 provider 返回最近刷新结果。实现抛错时 `Models` 将其视为没有模型。 */
	getModels(): readonly Model<TApi>[];

	/** 动态 provider 专用：恢复本 provider 缓存，并在允许时用有效凭证拉取新目录；失败时保留旧目录并响应共享 AbortSignal。 */
	refreshModels?(context: RefreshModelsContext): Promise<void>;

	/** 可选的凭证级可用性策略；`getModels()` 仍返回完整目录，`getAvailable()` 确认认证后才应用过滤。 */
	filterModels?(models: readonly Model<TApi>[], credential: Credential | undefined): readonly Model<TApi>[];

	stream<T extends TApi>(
		model: Model<T>,
		context: Context,
		options?: ApiStreamOptions<T>,
	): AssistantMessageEventStream;

	streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/**
 * Provider 的运行时集合。
 *
 * Provider 负责实际 stream；`Models` 负责认证、目录查询和把请求路由给 `model.provider` 对应的 Provider。
 */
export interface Models {
	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;

	/** 同步读取一个或全部 provider 的最近目录；异常 provider 按空目录处理。 */
	getModels(provider?: string): readonly Model<Api>[];

	/** 按 provider/id 同步查找最近目录；动态目录返回 `Model<Api>` 时可用 `hasApi()` 缩窄类型。 */
	getModel(provider: string, id: string): Model<Api> | undefined;

	/** 并发刷新已配置的动态 provider；错误和取消写入结果而不 reject，静态或未配置 provider 会被跳过。 */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;

	/** 在不刷新 OAuth 的前提下检查 provider 是否具备完整认证。 */
	checkAuth(providerId: string): Promise<AuthCheck | undefined>;

	/** 返回认证完整且通过 provider 可用性策略过滤后的模型。 */
	getAvailable(providerId?: string): Promise<readonly Model<Api>[]>;

	/**
	 * 按 provider ID 解析认证，或在传入模型时连同其静态 headers 一起解析；结果包含供状态 UI 使用的来源标识。
	 * 未知或未配置 provider 返回 undefined。OAuth 刷新失败抛出 code 为 "oauth" 的 `ModelsError`（保留原凭证，重新登录可恢复）；API key 解析或凭证存储失败则为 "auth"。请求路径会把这些异常收束为流错误。
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/** 执行 provider 自己的登录流程并持久化返回凭证。 */
	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;

	/** 删除某个 provider 的已存凭证。 */
	logout(providerId: string): Promise<void>;

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream;

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage>;

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
}

export interface MutableModels extends Models {
	/** 按唯一的 provider.id 新增或替换 Provider。 */
	setProvider(provider: Provider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

export interface CreateModelsOptions {
	/** 可注入持久化凭证存储，默认使用内存实现。 */
	credentials?: CredentialStore;
	/** 可注入动态模型目录存储，默认使用内存实现。 */
	modelsStore?: ModelsStore;
	/** 可注入运行时环境能力，供认证策略读取环境变量、文件等。 */
	authContext?: AuthContext;
}

/**
 * 不区分大小写地合并 HTTP headers。
 *
 * 调用者 headers 覆盖基础 headers；先删除不同大小写的同名键，避免同一语义 header 在底层请求中重复出现。
 */
function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/**
 * `Models` 的默认内存实现。
 *
 * 将可变 Provider 注册表与可替换的凭证/模型目录/认证环境聚合在一起；公开接口保持 Provider 本身无状态地负责协议请求。
 */
class ModelsImpl implements MutableModels {
	private providers = new Map<string, Provider>();
	private credentials: CredentialStore;
	private modelsStore: ModelsStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		// 未注入持久化实现时，使用只在当前进程存活的默认存储。
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.modelsStore = options?.modelsStore ?? new InMemoryModelsStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: Provider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly Provider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly Model<Api>[] {
		if (provider !== undefined) {
			// 单 provider 查询保持 best-effort：目录实现故障不应让模型选择 UI 整体失败。
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: Model<Api>[] = [];
		// 汇总模式同样隔离单个 provider 的目录读取异常。
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// best-effort：不可靠的 provider 视为没有可读模型。
			}
		}
		return models;
	}

	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

/**
	 * 并发刷新所有支持动态目录的 provider。
	 *
	 * 先解析可用于刷新目录的凭证；某 provider 失败后仍会尝试离线恢复其旧缓存，最终把错误收集到结果中。
	 */
	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const allowNetwork = options.allowNetwork ?? true;
		const errors = new Map<string, Error>();
		// 静态 provider 没有 refreshModels，无需进入后续认证和网络流程。
		const refreshable = Array.from(this.providers.values()).filter(
			(provider): provider is Provider & Required<Pick<Provider, "refreshModels">> =>
				provider.refreshModels !== undefined,
		);

		await Promise.all(
			refreshable.map(async (provider) => {
				if (options.signal?.aborted) return;
				// 向 provider 暴露受限存储视图，避免它接触其他 provider 的缓存。
				const store: ProviderModelsStore = {
					read: () => this.modelsStore.read(provider.id),
					write: (entry) => this.modelsStore.write(provider.id, entry),
					delete: () => this.modelsStore.delete(provider.id),
				};
				let stored: Credential | undefined;
				try {
					stored = await this.readCredential(provider.id);
					const credential = await this.resolveRefreshCredential(provider, stored, allowNetwork, options.signal);
					if (!credential) return;
					await provider.refreshModels({
						credential,
						store,
						allowNetwork,
						force: options.force,
						signal: options.signal,
					});
				} catch (error) {
					// 一次 provider 刷新失败不应阻塞其余 provider；错误由调用方按 provider ID 展示或处理。
					if (!options.signal?.aborted) {
						errors.set(
							provider.id,
							error instanceof Error
								? error
								: new ModelsError("model_source", `Model refresh failed for ${provider.id}`, { cause: error }),
						);
					}
					try {
						// 网络/认证失败后仍尝试离线恢复，以保留上一次成功的可用目录。
						await provider.refreshModels({
							credential: stored,
							store,
							allowNetwork: false,
							signal: options.signal,
						});
					} catch {
						// 保留原始认证/网络错误；缓存恢复本身仅尽力执行。
					}
				}
			}),
		);

		return { aborted: options.signal?.aborted ?? false, errors };
	}

	/** 为目录刷新解析可用凭证，并只在允许联网时刷新过期 OAuth token。 */
	private async resolveRefreshCredential(
		provider: Provider,
		stored: Credential | undefined,
		allowNetwork: boolean,
		signal?: AbortSignal,
	): Promise<Credential | undefined> {
		if (stored?.type === "oauth") {
			const oauth = provider.auth.oauth;
			if (!oauth) return undefined;
			if (!allowNetwork || Date.now() < stored.expires) return stored;
			if (signal?.aborted) return undefined;
			// 通过 modify 串行化刷新，避免并发 refresh 重复使用同一个 refresh token。
			const post = await this.credentials.modify(provider.id, async (current) => {
				if (current?.type !== "oauth" || Date.now() < current.expires) return undefined;
				return oauth.refresh(current, signal);
			});
			return post?.type === "oauth" ? post : undefined;
		}

		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		const credential = stored?.type === "api_key" ? stored : undefined;
		const result = await apiKey.resolve({ ctx: this.authContext, credential });
		if (!result) return undefined;
		return { type: "api_key", key: result.auth.apiKey, env: result.env };
	}

	/** 将凭证存储异常统一包装成上层可识别的 ModelsError。 */
	private async readCredential(providerId: string): Promise<Credential | undefined> {
		try {
			return await this.credentials.read(providerId);
		} catch (error) {
			throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
		}
	}

	/** 不触发 OAuth 刷新地检查已有凭证或 API key 解析器是否足以配置该 Provider。 */
	private async checkProviderAuth(
		provider: Provider,
		credential: Credential | undefined,
	): Promise<AuthCheck | undefined> {
		if (credential?.type === "oauth") {
			return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
		}
		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		if (apiKey.check) {
			try {
				return await apiKey.check({
					ctx: this.authContext,
					credential: credential?.type === "api_key" ? credential : undefined,
				});
			} catch (error) {
				throw new ModelsError("auth", `API key auth check failed for provider ${provider.id}`, { cause: error });
			}
		}

		const resolution = await resolveProviderAuth(provider, this.credentials, this.authContext);
		return resolution ? { source: resolution.source, type: "api_key" } : undefined;
	}

	async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		return this.checkProviderAuth(provider, await this.readCredential(providerId));
	}

	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		const providers = providerId
			? [this.providers.get(providerId)].filter((entry) => entry !== undefined)
			: this.getProviders();
		const checks = await Promise.all(
			providers.map(async (provider) => {
				const credential = await this.readCredential(provider.id);
				return { provider, credential, auth: await this.checkProviderAuth(provider, credential) };
			}),
		);
		return checks.flatMap(({ provider, credential, auth }) => {
			if (!auth) return [];
			const models = provider.getModels();
			return provider.filterModels?.(models, credential) ?? models;
		});
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	/**
	 * 解析 provider 或具体模型的认证结果。
	 *
	 * 传入模型时，还会合并模型静态 headers，供自定义模型覆盖 provider 级默认配置。
	 */
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		const result = await resolveProviderAuth(provider, this.credentials, this.authContext, overrides);
		if (!result || typeof providerOrModel === "string" || !providerOrModel.headers) return result;
		return {
			...result,
			auth: {
				...result.auth,
				headers: mergeHeaders(result.auth.headers, providerOrModel.headers),
			},
		};
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const provider = this.providers.get(providerId);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${providerId}`);
		const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
		if (!method?.login) {
			throw new ModelsError("auth", `${provider.name} does not support ${type} login`);
		}
		// 登录流程由 provider 定义，成功后才写入共享凭证存储。
		const credential = await method.login(interaction);
		try {
			await this.credentials.modify(providerId, async () => credential);
		} catch (error) {
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		return credential;
	}

	async logout(providerId: string): Promise<void> {
		try {
			await this.credentials.delete(providerId);
		} catch (error) {
			throw new ModelsError("auth", `Credential store delete failed for ${providerId}`, { cause: error });
		}
	}

	/** 获取模型所属 Provider；请求路径缺少注册时统一报 provider 错误。 */
	private requireProvider(model: Model<Api>): Provider {
		const provider = this.providers.get(model.provider);
		if (!provider) {
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		return provider;
	}

	/**
	 * 为一次请求准备最终模型与 options。
	 *
	 * 合并顺序：认证结果 → 模型 headers → 显式 options.headers → Models 专属 transformHeaders；随后剥离 transformHeaders 再分派，避免 Provider 看到集合层钩子。
	 */
	private async applyAuth<TOptions extends StreamOptions & ModelsStreamTransforms>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<{ requestModel: Model<Api>; requestOptions: StreamOptions | undefined }> {
		this.requireProvider(model);
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
		});
		if (!resolution) {
			throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		}
		const auth = resolution.auth;

		// 显式请求字段覆盖认证字段；Models 专属 header 变换始终最后执行。
		const apiKey = options?.apiKey ?? auth.apiKey;
		let headers = mergeHeaders(auth.headers, options?.headers);
		if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
		const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
		const requestOptions = { ...providerOptions, apiKey, headers, env } as StreamOptions;

		return { requestModel, requestOptions };
	}

	/** 通过 API 专属 options 发起流式请求；异步认证失败由 lazyStream 收束为 error 事件。 */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(
				model,
				options as ModelsApiStreamOptions<Api> | undefined,
			);
			return provider.stream(requestModel as Model<TApi>, context, requestOptions as ApiStreamOptions<TApi>);
		});
	}

	/** `complete()` 是 `stream().result()` 的便捷包装，不维护第二套请求实现。 */
	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	/** 使用跨 provider 的简化 options 发起流式请求。 */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.streamSimple(requestModel, context, requestOptions as SimpleStreamOptions);
		});
	}

	/** `completeSimple()` 对应 `streamSimple().result()`。 */
	async completeSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}
}

/** 创建空的可变 Provider 集合；调用方随后通过 setProvider() 注册 provider，或使用 builtinModels() 一次注册内置 provider。 */
export function createModels(options?: CreateModelsOptions): MutableModels {
	return new ModelsImpl(options);
}

export interface CreateProviderOptions<TApi extends Api = Api> {
	id: string;
	/** 用于 UI 的显示名称；默认使用 id。 */
	name?: string;
	baseUrl?: string;
	headers?: ProviderHeaders;
	/** 必填认证语义；环境凭证或无 key provider 也必须显式描述其解析规则。 */
	auth: ProviderAuth;
	/** 静态基线模型；纯动态 provider 可传空数组。 */
	models: readonly Model<TApi>[];
	/** 拉取动态模型覆盖层；createProvider 会经由 ModelsStore 恢复和持久化它。 */
	fetchModels?: (context: RefreshModelsContext) => Promise<readonly Model<TApi>[]>;
	filterModels?: (models: readonly Model<TApi>[], credential: Credential | undefined) => readonly Model<TApi>[];
	/** 单个协议实现，或按 `model.api` 键控的实现表，供混合协议 provider 分派。 */
	api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}

/**
 * 从认证、模型目录和协议实现组装标准 Provider。
 *
 * 内置工厂与 models.json 自定义 provider 共用此路径。动态模型会覆盖同 ID 的静态模型；混合协议 provider 则按 `model.api` 选择对应 `ProviderStreams`。
 */
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	const baselineModels = input.models;
	let dynamicModels: readonly Model<TApi>[] = [];
	let inflightRefresh: Promise<void> | undefined;
	const fetchModels = input.fetchModels;
	// 每次读取时合并目录，动态模型以 id 覆盖静态基线，便于服务端修正或更新静态条目。
	const currentModels = (): readonly Model<TApi>[] => {
		const merged = [...baselineModels];
		for (const model of dynamicModels) {
			const index = merged.findIndex((entry) => entry.id === model.id);
			if (index >= 0) merged[index] = model;
			else merged.push(model);
		}
		return merged;
	};
	// `api` 既可直接给一个实现，也可给按 API 协议键控的实现表。
	const single =
		typeof (input.api as ProviderStreams).stream === "function" ? (input.api as ProviderStreams) : undefined;
	const byApi = single ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);

	const apiFor = (model: Model<Api>): ProviderStreams | undefined => single ?? byApi?.[model.api];

	/** 把模型请求路由到选中的协议实现；缺少实现时仍返回 error stream，保持流式错误契约。 */
	const dispatch = (
		model: Model<Api>,
		run: (streams: ProviderStreams) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const streams = apiFor(model);
		if (!streams) {
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
		getModels: currentModels,
		refreshModels: fetchModels
			? (context) => {
					// 共享同一个 in-flight Promise，避免并发 refresh 重复读取缓存和发起远端请求。
					inflightRefresh ??= (async () => {
						try {
							// 先恢复缓存，即使后续网络失败也能保留最近可用目录。
							const stored = await context.store.read();
							if (stored) {
								dynamicModels = stored.models
									.filter((model) => model.provider === input.id)
									.map((model) => model as Model<TApi>);
							}
							// 离线模式或取消后只保留已恢复的缓存，不触碰远端。
							if (!context.allowNetwork || context.signal?.aborted) return;
							const refreshed = await fetchModels(context);
							if (context.signal?.aborted) return;
							dynamicModels = refreshed;
							await context.store.write({ models: refreshed, checkedAt: Date.now() });
						} finally {
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
		filterModels: input.filterModels,
		stream: (model, context, options) => dispatch(model, (streams) => streams.stream(model, context, options)),
		streamSimple: (model, context, options) =>
			dispatch(model, (streams) => streams.streamSimple(model, context, options)),
	};
}

/**
 * 为动态查到的模型执行运行时 API 检查并缩窄 TypeScript 类型：
 *
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options fully typed
 * }
 * ```
 */
export function hasApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi> {
	return model.api === api;
}

/**
 * 按模型费率与阶梯价就地计算 usage.cost。
 *
 * 1 小时 cache write 按 Anthropic 规则按基础输入费率的两倍计价；返回同一 cost 对象，方便 API 实现在组装最终消息时直接使用。
 */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates: ModelCostRates = model.cost;
	let matchedThreshold = -1;
	// 选择输入量已达到的最高阶梯；该阶梯价格适用于整次请求。
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// Anthropic 对 1 小时缓存写入按基础输入价格的两倍收费。
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/** 从低到高排列的统一推理档位，用于计算最接近的可用 fallback。 */
const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 返回模型真正可请求的统一推理档位，综合 reasoning 开关和 thinkingLevelMap 的显式禁用/扩展标记。 */
export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** 将请求档位夹到模型支持的最近档位，优先向更高档位寻找，再向更低档位回退。 */
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/** 按 provider 与模型 id 判断两个模型是否相同；任一缺失时返回 false。 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
