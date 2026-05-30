/**
 * 先导入内置 provider 注册逻辑。
 *
 * 这行 import 的目的不是为了直接使用某个导出，而是触发模块副作用：
 * - `register-builtins.ts` 在加载时会把 OpenAI / Anthropic
 *   provider 注册到全局注册表
 * - 这样后面的 `getApiProvider(model.api)` 才能取到对应实现
 *
 * 如果没有这行，`stream()` 虽然语法上能工作，但运行时会因为注册表为空而找不到 provider。
 */
import "./providers/register-builtins.ts";

import { getApiProvider } from "./api-registry.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.ts";

export { getEnvApiKey } from "./env-api-keys.ts";

/**
 * `packages/ai` 的“统一入口调度层”。
 *
 * 文件定位：
 * - 这个文件本身不做具体 provider 协议适配
 * - 它负责把“统一入口函数”调度到正确的 provider
 * - 也负责提供流式 / 非流式、完整参数 / 简化参数 这两组对外 API
 *
 * 整体调用链：
 * 1. 应用 / agent 调 `stream()` / `streamSimple()` / `complete()` / `completeSimple()`
 * 2. 这里根据 `model.api` 去 `api-registry.ts` 查询 provider
 * 3. provider 通常来自 `register-builtins.ts` 注册的懒加载实现
 * 4. provider 内部再去调用具体 SDK / HTTP 流
 * 5. 最终返回统一的 `AssistantMessageEventStream`
 *
 * 谁会调用这个文件里的入口：
 * - 外部 npm 使用者：直接 `import { streamSimple } from "@earendil-works/pi-ai"`
 * - `packages/agent`：默认通过 `streamSimple()` 把 LLM 请求接入 agent loop
 * - `packages/coding-agent`：通常不会直接碰 provider，而是通过 `pi-ai` 的这些入口下探到模型层
 */
function resolveApiProvider(api: Api) {
	// 这是“统一入口”与“具体 provider 实现”之间的唯一桥接点。
	// 上层只关心 model.api 是什么，不关心 provider 文件路径或初始化细节。
	const provider = getApiProvider(api);
	if (!provider) {
		// 正常情况下不会发生，因为文件顶部已经导入了 register-builtins.ts。
		// 如果发生，通常说明：
		// 1. 某个 api 没有被注册
		// 2. 新增 provider 时忘了在 register-builtins.ts 里接入
		// 3. 调用方传入了未知的 model.api
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

/**
 * 统一流式入口。
 *
 * 谁调用我：
 * - `@earendil-works/pi-ai` 的直接使用者
 * - `packages/agent` 默认通过 `streamSimple()` 走更高层封装；部分高级用法会直接用 `stream()`
 *
 * 我调用谁：
 * - `resolveApiProvider()` -> `getApiProvider()`
 * - 最终调用具体 provider 的 `stream()`
 *
 * 适用场景：
 * - 你已经知道自己要传 provider 级 options
 * - 你希望保留更底层、更完整的请求控制能力
 */
export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	// 第一步：根据模型的 api 类型找到对应 provider。
	// 例如：
	// - "openai-responses" -> openai-responses provider
	// - "anthropic" -> anthropic provider
	const provider = resolveApiProvider(model.api);

	// 第二步：把调用完整转发给 provider。
	// 从这里开始，stream.ts 就退出主流程了，后续的 payload 构造、SSE/SDK 流解析、
	// text_delta / toolcall_delta / done / error 事件翻译，都发生在 provider 内部。
	return provider.stream(model, context, options as StreamOptions);
}

/**
 * 非流式便捷入口。
 *
 * 内部并没有单独的“complete provider”实现，而是复用 `stream()`，
 * 最后等待 `AssistantMessageEventStream.result()`。
 *
 * 也就是说，`complete()` 本质上不是另一套调用链，而是：
 * - 先走完整流式链路
 * - 只是调用方自己不消费中间事件，只要最终结果
 */
export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	// 先拿到流。
	const s = stream(model, context, options);

	// 再等待流结束后的最终 AssistantMessage。
	// 这也是为什么流式和非流式的行为在语义上能保持一致：
	// 它们共享同一套 provider 实现，只是消费方式不同。
	return s.result();
}

/**
 * `streamSimple()` 面向更常见的“统一简单参数”场景。
 *
 * 谁调用我：
 * - `packages/agent` 的默认 `streamFn`
 * - `AgentHarness.createStreamFn()`
 *
 * 我调用谁：
 * - provider 的 `streamSimple()`，由 provider 负责把简单参数映射成具体请求参数
 *
 * 为什么这个入口很重要：
 * - `packages/agent` 和 `packages/coding-agent` 更常走这条链
 * - 它把“provider 专属复杂参数”藏到 provider 内部
 * - 上层只需要传更通用的 reasoning / tool / signal / apiKey 等简单参数
 */
export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	// 仍然是同一套调度逻辑：先按 model.api 找 provider。
	const provider = resolveApiProvider(model.api);

	// 与 `stream()` 的区别不在“怎么找 provider”，而在“传给 provider 的参数形态不同”。
	// `streamSimple()` 更像统一上层 API，provider 负责把它翻译成自己的底层 payload。
	return provider.streamSimple(model, context, options);
}

/**
 * `completeSimple()` 是 `streamSimple()` 的一次性消费包装。
 *
 * 它是 `coding-agent` / `agent` / 外部业务里最容易理解的入口之一：
 * - 我不要中间事件
 * - 我只要最后一条 assistant message
 *
 * 但实现上依然复用流式链路，这样可以避免：
 * - provider 同时维护两套实现
 * - 流式和非流式在边界行为上不一致
 */
export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
