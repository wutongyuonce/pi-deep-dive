import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

/**
 * `EventStream` 是 pi-ai 的通用异步事件总线。
 *
 * 典型调用链：
 * - 上游生产者：各 provider 的 `stream*()` 函数会 `new AssistantMessageEventStream()`
 * - 写入路径：provider 在收到 SDK / HTTP 流式事件后调用 `push()`
 * - 读取路径：`stream()` / `streamSimple()` 的调用方通过 `for await ... of` 消费
 * - 终态路径：调用方通过 `result()` 等待最终结果
 *
 * 这个类解决的是“生产者和消费者不同步”问题：
 * - 数据先到、消费者还没开始读：先进入 `queue`
 * - 消费者先开始等、数据还没到：把等待中的 `resolve` 存进 `waiting`
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		// 这里预先创建“最终结果 Promise”，后续在 `push()` / `end()` 里手动 resolve。
		// 调用者看起来像是在等待一次异步请求完成，内部其实是事件流结束后才兑现结果。
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	/**
	 * 上游生产者写入事件的唯一入口。
	 *
	 * 谁调用我：
	 * - `openai-responses.ts` / `anthropic.ts` / `google.ts` 等 provider
	 * - `register-builtins.ts` 里的 `forwardStream()` 也会把内层 provider 事件转推到外层流
	 *
	 * 我调用谁：
	 * - `this.resolveFinalResult()`：终结事件到来时兑现 `result()`
	 * - `waiter(...)`：若有消费者正在等待，立即唤醒对应的 `await`
	 */
	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			// `extractResult()` 把“终结事件”映射为最终结果。
			// 例如 AssistantMessageEventStream 里：
			// - done 事件 -> event.message
			// - error 事件 -> event.error
			this.resolveFinalResult(this.extractResult(event));
		}

		// 优先把事件交给已经在等待的消费者；没人等时再入队。
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	/**
	 * 主动结束事件流。
	 *
	 * 谁调用我：
	 * - provider 在正常完成或异常兜底后调用
	 * - `register-builtins.ts` 的 `forwardStream()` 在转发结束时调用
	 *
	 * 我调用谁：
	 * - `this.resolveFinalResult()`：如果显式给了 `result`
	 * - 所有 waiting 中的 `resolve`：通知消费者“没有后续事件了”
	 */
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// 所有挂起中的消费者都要收到 `done: true`，否则 `for await` 会永远挂住。
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	/**
	 * 让 `EventStream` 可以被 `for await ... of` 遍历。
	 *
	 * 谁调用我：
	 * - 任何消费端的 `for await (const event of stream)`
	 * - 例如 `agent-loop.ts` 的 `streamAssistantResponse()`
	 *
	 * 我依赖谁：
	 * - `queue`：消费已缓存的事件
	 * - `waiting`：当没事件可读时，把当前消费者挂起，等待未来的 `push()`
	 */
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				return;
			} else {
				// 这里把当前消费者的 `resolve` 放进 waiting，后续由 `push()` 负责唤醒。
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	/**
	 * 返回“这条流最终对应的业务结果”，而不是单个事件。
	 *
	 * 谁调用我：
	 * - `stream.ts` 的 `complete()` / `completeSimple()`
	 * - `agent-loop.ts` 在 done/error 分支里调用 `response.result()`
	 */
	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

/**
 * `AssistantMessageEventStream` 是 `EventStream` 的 LLM 专用版本。
 *
 * 它把 provider 发出的 `AssistantMessageEvent` 重新解释为：
 * - 终结条件：`done` 或 `error`
 * - 最终结果：`AssistantMessage`
 */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** 供扩展方创建标准流实现，避免直接依赖具体类名。 */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
