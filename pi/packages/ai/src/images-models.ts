/**
 * 图片 provider 运行时集合。
 *
 * 文件定位：
 * - 这是聊天侧 `models.ts` 在图片生成领域的对应实现
 * - 负责集中管理图片 provider、解析认证、刷新模型列表，并在调用时把请求分发给所属 provider
 *
 * 核心职责：
 * - 保存图片 provider 注册表
 * - 提供模型查询 / 刷新能力
 * - 在生成图片前统一合并 auth、headers、env 等请求信息
 */

import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.ts";
import type { CreateModelsOptions } from "./models.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ImagesOptions, ProviderImages } from "./types.ts";

/**
 * 图片生成 provider 接口。
 * - 聊天侧 `Provider` 接口在图片生成领域的对应实现
 * - 每个 provider 持有唯一的 id/name 标识、认证信息、模型列表以及图片生成能力
 */
export interface ImagesProvider {
	readonly id: string;
	readonly name: string;

	/**
	 * 认证配置。
	 * - 必须提供：`apiKey` / `oauth` 至少配置其一，语义与聊天侧 provider 保持一致
	 *
	 * 被谁调用：
	 * - `ImagesModels.getAuth()` 返回 undefined（当 provider 未配置时）
	 * - `resolveProviderAuth()` 根据此配置解析实际认证凭证
	 */
	readonly auth: ProviderAuth;

	/**
	 * 获取当前已知的模型列表（同步方法）。
	 * - 静态 provider 直接返回其内置模型目录
	 * - 动态 provider 返回最近一次 `refreshModels()` 刷新后的列表（首次刷新前为空列表）
	 *
	 * 约束：禁止抛出异常；`ImagesModels` 将抛异常的实现视为无模型处理
	 */
	getModels(): readonly ImagesModel<ImagesApi>[];

	/**
	 * 向远端拉取并更新模型列表（仅动态 provider 实现，可选方法）。
	 * 约束：可能因网络原因 reject；reject 后模型列表保留最近一次已知状态，后续调用可重试
	 */
	refreshModels?(): Promise<void>;

	/** 执行图片生成。 */
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/**
 * 聊天侧 `Models` 接口在图片生成领域的对应实现
 * 图片 provider 注册表的只读访问接口
 */
export interface ImagesModels {
	getProviders(): readonly ImagesProvider[];
	getProvider(id: string): ImagesProvider | undefined;

	/**
	 * 同步获取一个或所有 provider 的最近已知模型列表。
	 * - 指定 provider 参数时返回该 provider 的模型列表
	 * - 不指定时聚合所有已注册 provider 的模型列表
	 *
	 * 约束：尽力而为：某个 provider 的 `getModels()` 抛异常时跳过该 provider，不抛出到外层
	 */
	getModels(provider?: string): readonly ImagesModel<ImagesApi>[];

	/** 根据最近已知模型列表同步查找单个运行时模型。 */
	getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined;

	/**
	 * 触发动态 provider 重新拉取模型列表。
	 * - 指定 provider id 时仅刷新该 provider，该 provider 拉取失败则 reject 并抛出 `ModelsError`（"model_source"）
	 * - 不指定时并发刷新所有动态 provider，尽力而为不抛出
	 * - 静态 provider（未实现 `refreshModels` 方法）为无操作
	 */
	refresh(provider?: string): Promise<void>;

	/**
	 * 为指定图片模型解析请求认证信息。
	 * - 返回解析后的认证结果，当模型未知或 provider 未配置时返回 undefined
	 * - 真正的认证失败（如 OAuth 异常）会 reject 并抛出 `ModelsError`（"oauth" / "auth"）
	 *
	 * 契约：与 `Models.getAuth()` 保持一致
	 */
	getAuth(model: ImagesModel<ImagesApi>): Promise<AuthResult | undefined>;

	/**
	 * 通过所属 provider 执行图片生成，自动解析并合并认证信息。
	 * - 先解析 provider 认证，再将显式传入的 options 字段级合并到请求中
	 *   （显式 options 的字段覆盖解析出的认证字段；headers/env 为浅合并）
	 * - 永不抛出异常：所有失败情况均以 `AssistantImages` 返回，`stopReason` 为 "error"
	 */
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/**
 * 可变图片 provider 集合接口。
 * - 继承 `ImagesModels` 的只读能力，额外提供 provider 注册的写操作
 */
export interface MutableImagesModels extends ImagesModels {
	/** 插入或替换 provider（provider id 全局唯一，按 provider.id 去重）。 */
	setProvider(provider: ImagesProvider): void;
	/** 按 id 移除 provider。 */
	deleteProvider(id: string): void;
	/** 清空所有已注册的 provider。 */
	clearProviders(): void;
}

/** `MutableImagesModels` 的默认实现。 */
class ImagesModelsImpl implements MutableImagesModels {
	private providers = new Map<string, ImagesProvider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: ImagesProvider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly ImagesProvider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): ImagesProvider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly ImagesModel<ImagesApi>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: ImagesModel<ImagesApi>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		return models;
	}

	getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	/**
	 * 触发动态 provider 重新拉取模型列表。
	 * - 单 provider 刷新
	 * - 全量刷新
	 *
	 * 被谁调用：
	 * - 上层需要同步最新模型列表时调用
	 *
	 * 调用了谁：
	 * - `ImagesProvider.refreshModels()` 执行实际刷新
	 */
	async refresh(provider?: string): Promise<void> {
		// 1、单 provider 刷新：查找失败或静态 provider 直接返回；网络错误包装为 ModelsError 抛出。
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

		// 2、全量刷新：allSettled 兜底，任意单个 provider 失败不影响其他。
		await Promise.allSettled(Array.from(this.providers.values(), async (entry) => entry.refreshModels?.()));
	}

	/**
	 * 为指定图片模型解析请求认证信息。
	 *
	 * 作用：
	 * - 模型所属 provider 不存在时返回 undefined
	 * - 否则调用 `resolveProviderAuth()` 解析实际认证凭证
	 *
	 * 被谁调用：
	 * - `generateImages()` 在执行生成前调用此方法
	 *
	 * 调用了谁：
	 * - `resolveProviderAuth()` 执行实际认证解析
	 */
	async getAuth(model: ImagesModel<ImagesApi>): Promise<AuthResult | undefined> {
		const provider = this.providers.get(model.provider);
		if (!provider) return undefined;
		return resolveProviderAuth(provider, model, this.credentials, this.authContext);
	}

	/**
	 * 执行图片生成：解析认证、合并参数、分发请求并统一错误处理。
	 *
	 * 作用：
	 * 1. 找到模型所属 provider，不存在则抛出 `ModelsError`
	 * 2. 通过 `resolveProviderAuth()` 解析 provider 认证
	 * 3. 字段级合并请求参数：显式 options 覆盖 auth 解析结果，headers/env 为浅合并
	 * 4. 将合并后的请求分发给 provider，异常转为 `stopReason: "error"` 的 `AssistantImages` 响应
	 *
	 * 约束：
	 * - 永不 throw：所有异常均在 catch 中转为带有错误信息的 `AssistantImages` 返回
	 *
	 * 被谁调用：
	 * - 上层业务代码通过此方法发起图片生成
	 *
	 * 调用了谁：
	 * - `resolveProviderAuth()` 解析认证
	 * - `ImagesProvider.generateImages()` 执行实际生成
	 */
	async generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages> {
		try {
			// 1. 找到模型所属 provider，没有则立即报错。
			const provider = this.providers.get(model.provider);
			if (!provider) {
				throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
			}

			// 2. 统一解析 provider auth。
			const resolution = await resolveProviderAuth(provider, model, this.credentials, this.authContext, {
				apiKey: options?.apiKey,
				env: options?.env,
			});
			const auth = resolution?.auth;
			if (!auth) {
				return provider.generateImages(model, context, options);
			}

			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

			// 3. 字段级优先级合并：显式 options > auth 解析结果；headers/env 为浅合并。
			const apiKey = options?.apiKey ?? auth.apiKey;
			const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
			const env =
				resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;

			// 4. 将合并后的请求分发给 provider，并用 catch 兜底：异常转为 stopReason:"error" 的响应。
			return await provider.generateImages(requestModel, context, { ...options, apiKey, headers, env });
		} catch (error) {
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				output: [],
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			};
		}
	}
}

/** 创建一个可变的图片 provider 集合实例。 */
export function createImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	return new ImagesModelsImpl(options);
}

/** 创建图片 provider 的配置参数接口。 */
export interface CreateImagesProviderOptions {
	/** provider 唯一标识符。 */
	id: string;
	/** 展示名称。默认值：`id` */
	name?: string;
	/**
	 * 认证配置（必填）。
	 * 每个 provider 均有认证语义，即使是无密钥 / 环境变量型 provider 也需明确声明
	 */
	auth: ProviderAuth;
	/**
	 * 初始模型列表。
	 * - 静态 provider 通过此字段直接提供完整模型目录
	 * - 纯动态 provider 传空数组，后续由 `refreshModels` 填充
	 */
	models: readonly ImagesModel<ImagesApi>[];
	/**
	 * 动态 provider 的模型列表拉取函数。
	 * 成功时存储拉取结果；并发调用共享同一个进行中的请求（去重）。
	 * 可 reject：此时存储的列表保留在上次已知状态，rejection
	 * 传播到 `refreshModels()` 调用方（由 `ImagesModels.refresh(provider)`
	 * 包装为 `ModelsError("model_source")`），后续调用可重试。
	 */
	refreshModels?: () => Promise<readonly ImagesModel<ImagesApi>[]>;
	/** 图片生成的底层 API 实现。 */
	api: ProviderImages;
}

/**
 * 由零散配置拼装一个图片 provider。
 * - 将 `CreateImagesProviderOptions` 配置转为符合 `ImagesProvider` 接口的实例
 * - 内部处理 inflight 去重：并发 refreshModels 调用共享同一个 Promise
 *
 * 被谁调用：
 * - 内置 provider 定义模块（通过此函数创建标准 provider）
 * - 用户自定义 provider 的注册入口
 *
 * 调用了谁：
 * - `input.api.generateImages()` 执行实际图片生成
 * - `input.refreshModels()` 执行动态模型刷新
 */
export function createImagesProvider(input: CreateImagesProviderOptions): ImagesProvider {
	let models = input.models;
	let inflightRefresh: Promise<void> | undefined;
	const refreshModels = input.refreshModels;

	return {
		id: input.id,
		name: input.name ?? input.id,
		auth: input.auth,
		getModels: () => models,
		refreshModels: refreshModels
			? () => {
					// inflight 去重：并发调用共享同一个 Promise，避免重复请求。
					inflightRefresh ??= (async () => {
						try {
							models = await refreshModels();
						} finally {
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
		generateImages: (model, context, options) => input.api.generateImages(model, context, options),
	};
}
