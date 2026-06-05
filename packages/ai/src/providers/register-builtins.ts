import { clearApiProviders, registerApiProvider } from "../api-registry.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import type { AnthropicOptions } from "./anthropic.ts";
import type { OpenAICompletionsOptions } from "./openai-completions.ts";
import type { OpenAIResponsesOptions } from "./openai-responses.ts";

/**
 * 懒加载 provider 模块的统一接口。
 *
 * 每个 provider 模块（如 anthropic.ts、openai-completions.ts）都需要导出这两个函数。
 * 泛型参数：
 * - `TApi`：该 provider 服务的 API 协议名
 * - `TOptions`：完整参数类型（包含 provider 特有的选项）
 * - `TSimpleOptions`：简化参数类型（统一的 SimpleStreamOptions）
 */
interface LazyProviderModule<
	TApi extends Api,
	TOptions extends StreamOptions,
	TSimpleOptions extends SimpleStreamOptions,
> {
	stream: (model: Model<TApi>, context: Context, options?: TOptions) => AsyncIterable<AssistantMessageEvent>;
	streamSimple: (
		model: Model<TApi>,
		context: Context,
		options?: TSimpleOptions,
	) => AsyncIterable<AssistantMessageEvent>;
}

/**
 * Anthropic provider 模块的导出结构。
 * 用于类型断言，确保动态导入的模块包含正确的函数。
 */
interface AnthropicProviderModule {
	streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions>;
	streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions>;
}

/**
 * OpenAI Completions provider 模块的导出结构。
 * 用于类型断言，确保动态导入的模块包含正确的函数。
 */
interface OpenAICompletionsProviderModule {
	streamOpenAICompletions: StreamFunction<"openai-completions", OpenAICompletionsOptions>;
	streamSimpleOpenAICompletions: StreamFunction<"openai-completions", SimpleStreamOptions>;
}

/**
 * OpenAI Responses provider 模块的导出结构。
 * 用于类型断言，确保动态导入的模块包含正确的函数。
 */
interface OpenAIResponsesProviderModule {
	streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions>;
	streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions>;
}

/**
 * 懒加载的 Promise 缓存。
 *
 * 使用 `||=` 模式确保每个 provider 模块只被加载一次：
 * - 第一次调用时，`promise` 为 undefined，执行 import() 并缓存
 * - 后续调用时，直接返回已缓存的 promise
 */
// 联合类型 + 延迟初始化
let anthropicProviderModulePromise:
	| Promise<LazyProviderModule<"anthropic-messages", AnthropicOptions, SimpleStreamOptions>>
	| undefined;
let openAICompletionsProviderModulePromise:
	| Promise<LazyProviderModule<"openai-completions", OpenAICompletionsOptions, SimpleStreamOptions>>
	| undefined;
let openAIResponsesProviderModulePromise:
	| Promise<LazyProviderModule<"openai-responses", OpenAIResponsesOptions, SimpleStreamOptions>>
	| undefined;

/**
 * 将异步迭代器（source）的事件转发到 AssistantMessageEventStream（target）。
 *
 * 作用：
 * - provider 模块返回的是 AsyncIterable（惰性迭代器）
 * - 注册表需要的是 AssistantMessageEventStream（可订阅的事件流）
 * - 这个函数把两者桥接起来
 *
 * 执行流程：
 * 1. 创建一个异步 IIFE（立即执行函数）
 * 2. 用 for-await-of 逐个读取 source 的事件
 * 3. 每读到一个事件就 push 到 target
 * 4. source 结束后，调用 target.end() 通知所有订阅者
 */
function forwardStream(target: AssistantMessageEventStream, source: AsyncIterable<AssistantMessageEvent>): void {
	(async () => {
		for await (const event of source) {
			target.push(event);
		}
		target.end();
	})();
}

/**
 * 创建懒加载失败时的错误消息。
 *
 * 当动态 import() 失败时（如网络问题、模块不存在），生成一个标准的 AssistantMessage 错误对象。
 * 这样上层代码可以统一处理错误，不需要特殊处理懒加载失败的情况。
 */
function createLazyLoadErrorMessage<TApi extends Api>(model: Model<TApi>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/**
 * 创建懒加载的完整参数流式函数。
 *
 * 高阶函数：接收一个模块加载函数，返回一个 StreamFunction。
 *
 * 工作流程：
 * 1. 调用方传入 loadModule（如 loadAnthropicProviderModule）
 * 2. 返回一个新函数，这个函数就是 StreamFunction 类型
 * 3. 当这个新函数被调用时：
 *    a. 创建一个 AssistantMessageEventStream（outer）作为返回值
 *    b. 异步加载模块（loadModule()）
 *    c. 加载成功后，调用模块的 stream() 获取内部事件流（inner）
 *    d. 用 forwardStream 把 inner 的事件转发到 outer
 *    e. 如果加载失败，创建错误消息并推送到 outer
 * 4. 立即返回 outer（调用方可以立即订阅）
 *
 * 为什么要这样设计：
 * - 注册发生在模块加载时（import 时立即执行）
 * - 但实际的 provider 模块（如 anthropic.ts）可能很大
 * - 懒加载可以避免在启动时加载所有 provider，加快启动速度
 */
function createLazyStream<TApi extends Api, TOptions extends StreamOptions, TSimpleOptions extends SimpleStreamOptions>(
	loadModule: () => Promise<LazyProviderModule<TApi, TOptions, TSimpleOptions>>,
): StreamFunction<TApi, TOptions> {
	return (model, context, options) => {
		// 创建一个空的事件流，立即返回给调用方
		const outer = new AssistantMessageEventStream();

		// 异步加载模块
		// .then() 和 .catch() 是 Promise 链式语法 ，用于处理异步操作
		loadModule()
			.then((module) => {
				// 加载成功：调用模块的 stream()，把事件转发到 outer
				const inner = module.stream(model, context, options);
				forwardStream(outer, inner);
			})
			.catch((error) => {
				// 加载失败：创建错误消息并推送到 outer
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		// 立即返回 outer，调用方可以立即订阅事件
		return outer;
	};
}

/**
 * 创建懒加载的简化参数流式函数。
 *
 * 与 createLazyStream 完全相同的逻辑，只是调用模块的 streamSimple() 而不是 stream()。
 * 简化参数版本用于不需要 provider 特有选项的场景。
 */
function createLazySimpleStream<
	TApi extends Api,
	TOptions extends StreamOptions,
	TSimpleOptions extends SimpleStreamOptions,
>(loadModule: () => Promise<LazyProviderModule<TApi, TOptions, TSimpleOptions>>): StreamFunction<TApi, TSimpleOptions> {
	return (model, context, options) => {
		const outer = new AssistantMessageEventStream();

		loadModule()
			.then((module) => {
				const inner = module.streamSimple(model, context, options);
				forwardStream(outer, inner);
			})
			.catch((error) => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

/**
 * 加载 Anthropic provider 模块。
 *
 * 使用 `||=` 模式实现懒加载缓存：
 * - 第一次调用：执行 import("./anthropic.ts")，缓存 promise
 * - 后续调用：直接返回缓存的 promise
 *
 * .then() 中的类型断言：
 * - 动态导入的模块类型是 any
 * - 用 as AnthropicProviderModule 断言，确保模块导出了正确的函数
 * - 然后提取 stream 和 streamSimple 函数，组装成 LazyProviderModule
 */
function loadAnthropicProviderModule(): Promise<
	LazyProviderModule<"anthropic-messages", AnthropicOptions, SimpleStreamOptions>
> {
	anthropicProviderModulePromise ||= import("./anthropic.ts").then((module) => {
		// module 是一个包含所有导出的对象
		const provider = module as AnthropicProviderModule; // as 断言不检查是否完全匹配 ，只检查"是否兼容"
		return {
			stream: provider.streamAnthropic,
			streamSimple: provider.streamSimpleAnthropic,
		};
	});
	return anthropicProviderModulePromise;
}

/**
 * 加载 OpenAI Completions provider 模块。
 * 逻辑与 loadAnthropicProviderModule 完全相同。
 */
function loadOpenAICompletionsProviderModule(): Promise<
	LazyProviderModule<"openai-completions", OpenAICompletionsOptions, SimpleStreamOptions>
> {
	openAICompletionsProviderModulePromise ||= import("./openai-completions.ts").then((module) => {
		const provider = module as OpenAICompletionsProviderModule;
		return {
			stream: provider.streamOpenAICompletions,
			streamSimple: provider.streamSimpleOpenAICompletions,
		};
	});
	return openAICompletionsProviderModulePromise;
}

/**
 * 加载 OpenAI Responses provider 模块。
 * 逻辑与 loadAnthropicProviderModule 完全相同。
 */
function loadOpenAIResponsesProviderModule(): Promise<
	LazyProviderModule<"openai-responses", OpenAIResponsesOptions, SimpleStreamOptions>
> {
	openAIResponsesProviderModulePromise ||= import("./openai-responses.ts").then((module) => {
		const provider = module as OpenAIResponsesProviderModule;
		return {
			stream: provider.streamOpenAIResponses,
			streamSimple: provider.streamSimpleOpenAIResponses,
		};
	});
	return openAIResponsesProviderModulePromise;
}

/**
 * 创建并导出每个 provider 的懒加载流式函数。
 *
 * 这些导出的函数：
 * - 签名是 StreamFunction<TApi, TOptions>（或 TSimpleOptions）
 * - 内部是懒加载的，首次调用时才加载真正的 provider 模块
 * - 会被传递给 registerApiProvider() 注册到全局注册表
 */
export const streamAnthropic = createLazyStream(loadAnthropicProviderModule);
export const streamSimpleAnthropic = createLazySimpleStream(loadAnthropicProviderModule);
export const streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule);
export const streamSimpleOpenAICompletions = createLazySimpleStream(loadOpenAICompletionsProviderModule);
export const streamOpenAIResponses = createLazyStream(loadOpenAIResponsesProviderModule);
export const streamSimpleOpenAIResponses = createLazySimpleStream(loadOpenAIResponsesProviderModule);

/**
 * 注册所有内置 provider 到全局注册表。
 *
 * 被调用时机：
 * - 模块加载时（文件末尾的 registerBuiltInApiProviders()）
 * - resetApiProviders() 重建注册表时
 *
 * 每个 registerApiProvider() 调用：
 * - api：注册的 key，对应 Model.api 字段
 * - stream：完整参数的流式函数（懒加载包装后）
 * - streamSimple：简化参数的流式函数（懒加载包装后）
 */
export function registerBuiltInApiProviders(): void {
	registerApiProvider({
		api: "anthropic-messages",
		stream: streamAnthropic,
		streamSimple: streamSimpleAnthropic,
	});

	registerApiProvider({
		api: "openai-completions",
		stream: streamOpenAICompletions,
		streamSimple: streamSimpleOpenAICompletions,
	});

	registerApiProvider({
		api: "openai-responses",
		stream: streamOpenAIResponses,
		streamSimple: streamSimpleOpenAIResponses,
	});
}

/**
 * 重置注册表：清空所有 provider，重新注册内置 provider。
 *
 * 用途：
 * - 测试隔离：每个测试用例可以重置到干净状态
 * - 运行时重建：某些场景需要彻底重建 provider 集合
 */
export function resetApiProviders(): void {
	clearApiProviders();
	registerBuiltInApiProviders();
}

// 模块加载时立即注册内置 provider。
// 这是"副作用导入"模式：
// - stream.ts 导入本文件时，这行代码会执行
// - 执行后，所有内置 provider 就注册到全局注册表了
// - 之后 stream.ts 就可以通过 getApiProvider() 查找 provider
registerBuiltInApiProviders();
