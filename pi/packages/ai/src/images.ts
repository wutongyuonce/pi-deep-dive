/**
 * 图片生成总入口。
 *
 * 文件定位：
 * - 这是图片能力侧对应 `stream()` 的统一入口
 * - 负责确保内置图片 API 已注册，并按 `model.api` 找到具体的图片实现
 *
 * 调用链路：
 * - 模型侧通过 `ImagesModels.generateImages()` 或外部直接调用 `generateImages()`
 * - 本文件解析 API provider 后转发给具体实现
 */

import "./providers/images/register-builtins.ts";

import { getImagesApiProvider } from "./images-api-registry.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ProviderImagesOptions } from "./types.ts";

/**
 * 根据 api 标识查找已注册的图片 API provider，未找到时抛出明确错误。
 * 被谁调用：仅供 {@link generateImages} 调用。
 * 调用了谁：调用 {@link getImagesApiProvider} 查询注册表。
 */
function resolveImagesApiProvider(api: ImagesApi) {
	const provider = getImagesApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

/**
 * 外部调用图片能力时的统一分发入口。按图片模型声明的 `api` 分发到具体图片生成实现。
 * 被谁调用：外部业务代码或模型侧通过 {@link ImagesModels.generateImages} 间接调用。
 * 调用了谁：调用 {@link resolveImagesApiProvider} 解析 provider，然后调用 provider 的 generateImages。
 */
export async function generateImages<TApi extends ImagesApi>(
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: ProviderImagesOptions,
): Promise<AssistantImages> {
	// 按 model.api 查找注册的图片 API 实现，未注册则立即抛错。
	const provider = resolveImagesApiProvider(model.api);
	// 将请求转发给具体的图片 API 实现。
	return provider.generateImages(model, context, options);
}
