import { IMAGE_MODELS } from "./image-models.generated.ts";
import type { ImagesApi, ImagesModel, KnownImagesProvider } from "./types.ts";

/**
 * 图片模型注册表。
 *
 * 结构：provider 名 → (模型 ID → 模型元信息)
 * 例如："openrouter" → "dall-e-3" → ImagesModel
 *
 * 模块加载时从 models.generated.ts 自动初始化。
 */
const imageModelRegistry: Map<string, Map<string, ImagesModel<ImagesApi>>> = new Map();

// 模块加载时，把 IMAGE_MODELS 静态数据转成 Map 结构注册到注册表。
for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
	const providerModels = new Map<string, ImagesModel<ImagesApi>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as ImagesModel<ImagesApi>);
	}
	imageModelRegistry.set(provider, providerModels);
}

/**
 * 从 IMAGE_MODELS 静态类型中推断指定 provider + modelId 对应的 API 协议名。
 *
 * 例如：ImageModelApi<"openrouter", "dall-e-3"> → "openrouter-images"
 * 这样 getImageModel() 的返回类型能自动携带正确的 API 泛型。
 */
type ImageModelApi<
	TProvider extends KnownImagesProvider,
	TModelId extends keyof (typeof IMAGE_MODELS)[TProvider],
> = (typeof IMAGE_MODELS)[TProvider][TModelId] extends { api: infer TApi }
	? TApi extends ImagesApi
		? TApi
		: never
	: never;

/**
 * 获取指定 provider 和模型 ID 的图片模型元信息。
 *
 * @example
 * ```typescript
 * const model = getImageModel("openrouter", "dall-e-3");
 * // model.api 自动推断为 "openrouter-images"
 * ```
 */
export function getImageModel<
	TProvider extends KnownImagesProvider,
	TModelId extends keyof (typeof IMAGE_MODELS)[TProvider],
>(provider: TProvider, modelId: TModelId): ImagesModel<ImageModelApi<TProvider, TModelId>> {
	const providerModels = imageModelRegistry.get(provider);
	return providerModels?.get(modelId as string) as ImagesModel<ImageModelApi<TProvider, TModelId>>;
}

/**
 * 获取所有已注册的图片服务提供商列表。
 */
export function getImageProviders(): KnownImagesProvider[] {
	return Array.from(imageModelRegistry.keys()) as KnownImagesProvider[];
}

/**
 * 获取指定提供商下的所有图片模型列表。
 */
export function getImageModels<TProvider extends KnownImagesProvider>(
	provider: TProvider,
): ImagesModel<ImageModelApi<TProvider, keyof (typeof IMAGE_MODELS)[TProvider]>>[] {
	const models = imageModelRegistry.get(provider);
	return models
		? (Array.from(models.values()) as ImagesModel<ImageModelApi<TProvider, keyof (typeof IMAGE_MODELS)[TProvider]>>[])
		: [];
}
