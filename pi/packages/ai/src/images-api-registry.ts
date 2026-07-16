/**
 * 图片 API 注册表。
 *
 * 文件定位：
 * - 这是图片生成侧的 API 分发表
 * - 职责与聊天侧的 `api-registry.ts` 类似，但目标是 `generateImages()`
 *
 * 核心职责：
 * - 注册某个 `ImagesApi` 对应的实现
 * - 对外暴露查询入口
 * - 在运行时校验模型的 `api` 与被调用实现是否匹配
 */

import type { AssistantImages, ImagesApi, ImagesContext, ImagesFunction, ImagesModel, ImagesOptions } from "./types.ts";

/**
 * 图片生成 API 实现函数的标准签名。
 *
 * 定位：作为注册表内部存储的统一函数类型，消去泛型参数以便统一管理。
 * 作用：接收图片模型、上下文和可选参数，返回 AssistantImages 结果。
 * 被谁调用：由 {@link wrapGenerateImages} 包装后存入注册表，再由 {@link generateImages} 调用。
 * 调用了谁：由具体的 ImagesApi 实现提供。
 */
export type ImagesApiFunction = (
	model: ImagesModel<ImagesApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => Promise<AssistantImages>;

/**
 * 图片 API provider 的外部注册契约。
 *
 * 定位：第三方或内置图片提供方注册时使用的接口，由 {@link registerImagesApiProvider} 接收。
 * 作用：声明某个 ImagesApi 对应的 generateImages 实现，保留泛型以便类型安全调用。
 */
export interface ImagesApiProvider<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> {
	api: TApi;
	generateImages: ImagesFunction<TApi, TOptions>;
}

/**
 * 图片 API provider 的内部存储形态。
 *
 * 定位：注册表内部的统一类型，将泛型擦除为基类型以便集中存储。
 * 作用：抹平不同 provider 的类型差异，存储到 {@link imagesApiProviderRegistry} 中。
 * 被谁调用：由 {@link getImagesApiProvider} 读取，供 {@link resolveImagesApiProvider} 使用。
 */
interface ImagesApiProviderInternal {
	api: ImagesApi;
	generateImages: ImagesApiFunction;
}

/**
 * 已注册图片 API provider 的存储条目。
 *
 * 定位：注册表 Map 的 value 类型。
 * 作用：存储内部 provider 实现及其可选的来源标识，便于追踪和排查。
 */
type RegisteredImagesApiProvider = {
	provider: ImagesApiProviderInternal;
	sourceId?: string;
};

/**
 * 全局图片 API provider 注册表。
 *
 * 定位：模块级单例 Map，以 api 字符串为 key，存储所有已注册的图片生成实现。
 * 作用：作为图片 API 分发的核心数据结构，支撑 {@link registerImagesApiProvider} 和 {@link getImagesApiProvider}。
 */
const imagesApiProviderRegistry = new Map<string, RegisteredImagesApiProvider>();

/**
 * 为图片生成函数包一层运行时校验。
 *
 * 定位：注册表内部使用的包装器，确保分发的类型安全。
 * 作用：避免把 `openrouter-images` 的模型误传给别的图片 API 实现。
 * 校验逻辑：在调用真正的 generateImages 之前检查 `model.api` 是否与注册的 api 一致。
 * 被谁调用：仅供 {@link registerImagesApiProvider} 在注册时调用。
 * 调用了谁：包装并返回一个新的 {@link ImagesApiFunction}，内部调用原始的 generateImages。
 */
function wrapGenerateImages<TApi extends ImagesApi, TOptions extends ImagesOptions>(
	api: TApi,
	generateImages: ImagesFunction<TApi, TOptions>,
): ImagesApiFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return generateImages(model as ImagesModel<TApi>, context, options as TOptions);
	};
}

/**
 * 注册一个图片 API provider。
 *
 * 定位：图片 API 注册表的写入入口，供各图片 provider 模块在加载时注册自己的实现。
 * 作用：将带有运行时校验的 provider 存入 {@link imagesApiProviderRegistry}。
 * @param provider 图片 API 的实现对象
 * @param sourceId 可选来源标识，便于后续按来源移除或排查
 * 被谁调用：由内置图片 provider（如 `register-builtins.ts`）或第三方图片插件调用。
 * 调用了谁：调用 {@link wrapGenerateImages} 包装原始实现后再存入注册表。
 */
export function registerImagesApiProvider<TApi extends ImagesApi, TOptions extends ImagesOptions>(
	provider: ImagesApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	imagesApiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			generateImages: wrapGenerateImages(provider.api, provider.generateImages),
		},
		sourceId,
	});
}

/**
 * 读取指定图片 API 当前注册的实现。
 *
 * 定位：注册表的读取入口，O(1) 查找。
 * 作用：按 api 标识从 {@link imagesApiProviderRegistry} 中查找对应的 provider 实现。
 * 被谁调用：由 {@link resolveImagesApiProvider} 调用，间接服务于 {@link generateImages}。
 * 调用了谁：仅读取 {@link imagesApiProviderRegistry} Map。
 */
export function getImagesApiProvider(api: ImagesApi): ImagesApiProviderInternal | undefined {
	return imagesApiProviderRegistry.get(api)?.provider;
}
