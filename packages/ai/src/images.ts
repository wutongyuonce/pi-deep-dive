/**
 * 图片生成的统一入口层。
 *
 * 与文本流式入口 stream.ts 对称，但更简单：
 * - 文本是流式的（返回 AssistantMessageEventStream）
 * - 图片是非流式的（返回 Promise<AssistantImages>）
 *
 * 调用链：
 * 1. 外部调用 generateImages(model, context, options)
 * 2. 根据 model.api 查找注册表中的 provider
 * 3. 调用 provider 的 generateImages()，返回图片结果
 */

// 副作用导入：触发图片 provider 的内置注册（目前只有 openrouter-images）。
import "./providers/images/register-builtins.ts";

import { getImagesApiProvider } from "./images-api-registry.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ProviderImagesOptions } from "./types.ts";

/**
 * 根据 api 协议名查找已注册的图片 provider。
 * 如果找不到，抛出错误（说明没有注册对应的 provider）。
 */
function resolveImagesApiProvider(api: ImagesApi) {
	const provider = getImagesApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

/**
 * 图片生成的统一入口函数。
 *
 * @example
 * ```typescript
 * const model = getImageModel("openrouter", "dall-e-3");
 * const result = await generateImages(model, { input: [{ type: "text", text: "a cat" }] });
 * ```
 */
export async function generateImages<TApi extends ImagesApi>(
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: ProviderImagesOptions,
): Promise<AssistantImages> {
	const provider = resolveImagesApiProvider(model.api);
	return provider.generateImages(model, context, options);
}
