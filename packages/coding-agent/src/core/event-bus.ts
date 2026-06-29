/**
 * event-bus.ts - 轻量级事件总线
 *
 * 作用：提供基于 channel 的发布-订阅机制，用于模块间解耦通信。
 * 定位：core 层的基础工具，被 extensions 系统和其他模块使用。
 *
 * 提供的能力：
 * - EventBus 接口：只读的发布/订阅 API，供消费者使用
 * - EventBusController 接口：扩展 EventBus，增加 clear() 方法，供生产者控制
 * - createEventBus() 工厂函数：创建事件总线实例
 *
 * 设计特点：
 * - 内部基于 Node.js EventEmitter 实现
 * - 事件处理器自动包裹为 async 安全版本，异常不会影响其他监听器
 * - on() 返回取消订阅函数，防止内存泄漏
 */

import { EventEmitter } from "node:events";

/**
 * 事件总线的消费者接口。
 * 调用方：扩展系统、工具系统等需要跨模块通信的组件。
 */
export interface EventBus {
	/** 向指定 channel 发布事件 */
	emit(channel: string, data: unknown): void;
	/** 订阅指定 channel 的事件，返回取消订阅函数 */
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/**
 * 事件总线的生产者接口，继承自 EventBus，增加了清空所有监听器的能力。
 * 调用方：负责创建和销毁事件总线的宿主组件。
 */
export interface EventBusController extends EventBus {
	/** 移除所有 channel 上的所有监听器 */
	clear(): void;
}

/**
 * 创建事件总线实例。
 *
 * 内部步骤：
 * 1. 创建 Node.js EventEmitter 实例
 * 2. 返回包含 emit/on/clear 方法的对象
 * 3. on() 方法会将 handler 包裹为 async 安全版本，捕获异常并打印错误
 *
 * 定位：简单场景下的进程内事件通道工厂。
 * 作用：为调用方提供一个可随 runtime 生命周期创建和销毁的轻量消息总线。
 * 调用关系：被扩展运行时和其他需要跨模块广播事件的模块创建并持有。
 *
 * @returns EventBusController 实例，可发布、订阅、清空事件
 */
export function createEventBus(): EventBusController {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			// 包裹为安全的异步处理器，异常不会向上冒泡
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			// 返回取消订阅函数
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}
