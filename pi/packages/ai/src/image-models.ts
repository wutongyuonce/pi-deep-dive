/**
 * 内置图片模型查询工具。
 *
 * 文件定位：
 * - 这是自动生成图片模型目录 `image-models.generated.ts` 的轻量查询层
 * - 负责把静态对象预构建成按 provider / modelId 检索更方便的 Map 结构
 *
 * 提供能力：
 * - 根据 provider + modelId 读取单个图片模型
 * - 枚举所有图片 provider
 * - 枚举某个 provider 下的全部图片模型
 */

import { IMAGE_MODELS } from "./image-models.generated.ts";
import type { ImagesApi, ImagesModel, KnownImagesProvider } from "./types.ts";

const imageModelRegistry: Map<string, Map<string, ImagesModel<ImagesApi>>> = new Map();

// 启动时把 IMAGE_MODELS 常量对象平铺为双层 Map：provider → modelId → model，方便运行时 O(1) 按 provider 和 modelId 查询。
for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
	const providerModels = new Map<string, ImagesModel<ImagesApi>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as ImagesModel<ImagesApi>);
	}
	imageModelRegistry.set(provider, providerModels);
}

/** 从内置图片模型目录中提取某个模型的 API 类型。 */
type ImageModelApi<
	TProvider extends KnownImagesProvider,
	TModelId extends keyof (typeof IMAGE_MODELS)[TProvider],
> = (typeof IMAGE_MODELS)[TProvider][TModelId] extends { api: infer TApi }
	? TApi extends ImagesApi
		? TApi
		: never
	: never;

/** 按 provider 和 modelId 读取单个图片模型。 */
export function getImageModel<
	TProvider extends KnownImagesProvider,
	TModelId extends keyof (typeof IMAGE_MODELS)[TProvider],
>(provider: TProvider, modelId: TModelId): ImagesModel<ImageModelApi<TProvider, TModelId>> {
	const providerModels = imageModelRegistry.get(provider);
	return providerModels?.get(modelId as string) as ImagesModel<ImageModelApi<TProvider, TModelId>>;
}

/** 返回当前内置图片模型目录里的 provider 列表。 */
export function getImageProviders(): KnownImagesProvider[] {
	return Array.from(imageModelRegistry.keys()) as KnownImagesProvider[];
}

/** 返回某个图片 provider 下的全部静态模型。 */
export function getImageModels<TProvider extends KnownImagesProvider>(
	provider: TProvider,
): ImagesModel<ImageModelApi<TProvider, keyof (typeof IMAGE_MODELS)[TProvider]>>[] {
	const models = imageModelRegistry.get(provider);
	return models
		? (Array.from(models.values()) as ImagesModel<ImageModelApi<TProvider, keyof (typeof IMAGE_MODELS)[TProvider]>>[])
		: [];
}
