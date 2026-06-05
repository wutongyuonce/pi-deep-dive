import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.ts";

/**
 * API 注册表是 `stream.ts` 和具体 provider 之间的桥接层
 *
 * 调用链：
 * - `providers/register-builtins.ts` 在模块加载时调用 `registerApiProvider()`
 * - `stream.ts` 在请求到来时调用 `getApiProvider()`
 * - 这里用 `wrapStream*()` 在注册时做一次 API 一致性校验
 *
 * 这个文件的核心价值：
 * - 让 `stream.ts` 不需要知道 provider 文件路径
 * - 让 provider 可以在运行时被注册、覆盖、卸载
 * - 让测试代码或扩展代码能够替换内置 provider，而不用改入口层
 */
/** 注册表内部使用的统一流式函数签名（完整参数版本）。 */
export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

/** 注册表内部使用的统一流式函数签名（简化参数版本）。 */
export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * 对外暴露的强类型 provider 接口。
 *
 * 泛型参数：
 * - `TApi`：该 provider 服务的 API 协议名，如 "openai-responses"
 * - `TOptions`：该 provider 接受的完整参数类型
 *
 * `stream` 和 `streamSimple` 保留各自的强类型签名，
 * 注册时由 `wrapStream()` / `wrapStreamSimple()` 统一擦除为内部签名。
 */
export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

/**
 * 注册表内部存储的类型擦除后的 provider。
 *
 * 与 `ApiProvider` 的区别：
 * - `ApiProvider` 保留泛型，供扩展方 / 测试代码使用
 * - `ApiProviderInternal` 把泛型擦除为 `Api` / `StreamOptions`，
 *   这样注册表可以用统一的 `Map<string, ApiProviderInternal>` 存储所有 provider
 */
interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}

/**
 * 注册表中每条记录的完整结构。
 *
 * `sourceId` 用于标记 provider 来源，方便按来源批量卸载：
 * - 内置 provider 通常不设置 sourceId
 * - 动态注册方可以用它标记"这一批 provider 是我加的"
 * - 卸载时按 sourceId 过滤，避免误删其它来源
 */
type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string; // ?表示可选
};

// 全局注册表：
// key 是 `model.api`，例如 "openai-responses" / "anthropic-messages"
// value 是统一包装后的 provider 实现及其来源信息。
const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

/**
 * 把强类型的 provider stream 包成统一签名，并在运行时校验 `model.api`。
 *
 * 谁调用我：
 * - `registerApiProvider()`
 *
 * 我调用谁：
 * - 具体 provider 的 `stream()`
 */
function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		// 这里做一次非常重要的运行时防线：
		// 注册时声称自己服务于某个 api 的 provider，真正被调用时必须只接收同 api 的 model。
		// 这样即使上层因为类型擦除或错误注册把 model 传错了，也能尽早报错。
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}

		// 经过检查后，再把统一签名转回 provider 自己的强类型签名。
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

/** `streamSimple()` 对应的统一包装版本，职责与 `wrapStream()` 相同。 */
function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}

		// `streamSimple()` 与 `stream()` 的包装思想完全相同；
		// 区别只在于这里传的是更统一、更简化的 options 形态。
		return streamSimple(model as Model<TApi>, context, options);
	};
}

/**
 * 注册 provider。
 *
 * 谁调用我：
 * - `register-builtins.ts`
 * - 也可被扩展方 / 测试代码用于覆盖内置 provider
 *
 * 我调用谁：
 * - `wrapStream()` / `wrapStreamSimple()`，把 provider 统一成注册表内部格式
 */
export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	// 注册时就把 provider 包装成“统一内部格式”，这样查询阶段不需要再做类型适配。
	// 这也是为什么 `stream.ts` 的入口层可以保持非常薄。
	apiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
		},
		sourceId,
	});
}

/**
 * 查询单个 API 的 provider；`stream.ts` 的入口函数会走这里。
 *
 * 这是“统一入口层”最直接依赖的函数：
 * - `stream()` / `streamSimple()` 只做一件事：根据 model.api 调这里拿 provider
 */
export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.provider;
}

/**
 * 主要用于诊断或调试：列出当前所有已注册 provider。
 *
 * 常见用途：
 * - 调试当前运行环境里到底有哪些 provider 被装上了
 * - 测试里断言某个 provider 是否已注册
 */
export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

/**
 * 按来源批量卸载 provider，方便测试或可插拔扩展做清理。
 *
 * `sourceId` 的意义：
 * - 内置 provider 通常不依赖它
 * - 动态注册方可以用它标记“这一批 provider 是我加的”
 * - 清理时按 sourceId 一次性移除，避免误删其它来源
 */
export function unregisterApiProviders(sourceId: string): void {
	for (const [api, entry] of apiProviderRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			apiProviderRegistry.delete(api);
		}
	}
}

/**
 * 清空整个注册表；`resetApiProviders()` 会先调用它再重新注册内置项。
 *
 * 主要用于：
 * - 测试隔离
 * - 运行时需要彻底重建 provider 集合的场景
 */
export function clearApiProviders(): void {
	apiProviderRegistry.clear();
}
