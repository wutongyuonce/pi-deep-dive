/**
 * 懒加载 API 模块的流式调用包装。
 *
 * 文件定位：pi-ai 的统一懒加载层，位于 `src/api/lazy.ts`。
 *
 * 解决的问题：
 * - provider 的 API 实现模块（anthropic-messages、openai-responses 等）体积较大且
 *   在运行时可能用不到，不宜在启动时全部导入
 * - 认证解析（OAuth refresh、credential store 读取）需要异步等待，不能阻塞调用方
 *
 * 核心机制：
 * - `lazyStream()`：立即返回一个空的 `AssistantMessageEventStream`，异步 setup 完成后
 *   将内部流的全部事件转发到外层。setup 失败时以 error 事件终止流。
 * - `lazyApi()`：把 `() => Promise<ProviderStreams>` 包装成 `ProviderStreams` 接口，
 *   每次 stream/streamSimple 调用时才触发模块加载。
 *
 * 谁调用我：
 * - 每个 API 模块的 `.lazy.ts` 文件（如 `anthropic-messages.lazy.ts`）调用 `lazyApi()`
 * - `Models.applyAuth()`  内部调用 `lazyStream()` 包装认证解析 + provider stream
 */
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

/**
 * 构造一条代表 setup 失败的 AssistantMessage。
 *
 * 当懒加载或认证解析抛出异常时，用此函数生成一条错误终止消息，
 * 其 token 用量全为零，stopReason 为 "error"，原始错误信息写入 errorMessage。
 */
function createSetupErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
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
 * 类型守卫：判断 source 是否带有 `result()` 方法。
 *
 * `AssistantMessageEventStream` 实现了 `result()`，而普通 `AsyncIterable` 没有。
 * `forwardStream` 据此决定传给 `target.end()` 的值。
 */
function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

/**
 * 将 source 流的所有事件转发到 target 流。
 *
 * 逐事件消费 source，通过 `target.push()` 推入外层流。
 * source 迭代完毕后，用 `target.end()` 关闭外层流：
 * - 若 source 有 `result()` 方法（即它本身是 `AssistantMessageEventStream`），
 *   则将其最终结果传入 end；否则传 undefined。
 */
async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
): Promise<void> {
	for await (const event of source) {
		target.push(event);
	}
	target.end(hasResult(source) ? await source.result() : undefined);
}

/**
 * 返回一个外层流，同时在后台执行异步 setup（认证解析、懒模块加载）。
 *
 * 调用链：Models.stream() / lazyApi 返回的 stream()
 *   → lazyStream(model, async () => { /* setup */ return innerStream })
 *   → 同步返回 outerStream
 *   → 异步 setup().then(inner => forwardStream(outer, inner))
 *   → 调用方通过 for await 消费 outerStream 中的事件
 *
 * setup 失败时，以 error 事件终止流，而非抛异常。
 *
 * @param model 请求的模型（用于在 error 消息中填充 provider/model 字段）
 * @param setup 异步 setup 函数，返回一个事件源
 * @returns 同步返回的空流，事件由后台 setup 完成时注入
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
): AssistantMessageEventStream {
	// 先创建一个空流立即返回，让调用方可以同步订阅。
	const outer = new AssistantMessageEventStream();

	// 后台执行 setup，成功后转发事件，失败时发射 error 事件。
	setup()
		.then((inner) => forwardStream(outer, inner))
		.catch((error) => {
			const message = createSetupErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
}

/**
 * 将动态导入的 API 实现模块包装为 ProviderStreams 接口。
 *
 * 每个 API 模块（如 anthropic-messages）的 `.lazy.ts` 文件调用此函数，
 * 传入 `() => import("./anthropic-messages.ts")`。模块在首次 stream/streamSimple
 * 调用时才真正加载，后续调用复用 Node 模块缓存。
 *
 * 被谁调用：
 *   - anthropic-messages.lazy.ts: lazyApi(() => import("./anthropic-messages.ts"))
 *   - openai-responses.lazy.ts:   lazyApi(() => import("./openai-responses.ts"))
 *   - 所有 API 模块的 .lazy.ts 入口
 *
 * @param load 返回 ProviderStreams 的异步工厂（通常是动态 import，比如 () => import("./openai-responses.ts")）
 * @returns 符合 ProviderStreams 接口的包装对象，每次调用都走 lazyStream
 */
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams {
	return {
		stream: (model, context, options) =>
			lazyStream(model, async () => (await load()).stream(model, context, options)),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
	};
}
