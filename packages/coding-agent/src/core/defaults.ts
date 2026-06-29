/**
 * defaults.ts - core 层共享默认值常量
 *
 * 定位：`packages/coding-agent/src/core` 下的默认值收口点，供模型解析、会话初始化等流程复用。
 *
 * 作用：
 * - 统一默认思考级别，避免多个模块各自硬编码
 * - 作为 CLI 未传参、设置未命中时的最终兜底值
 *
 * 调用关系：
 * - 被 `model-resolver.ts` 用于初始模型和思考级别决策
 * - 被 `agent-session.ts` 在模型切换、恢复时作为降级默认值引用
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/**
 * 默认思考级别。
 *
 * 定位：会话启动和模型切换流程的兜底值。
 * 作用：当用户、会话、设置都没有显式给出思考级别时，统一回落到 `medium`。
 * 调用关系：由 `model-resolver.ts` 和 `agent-session.ts` 读取，不在本文件内修改。
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
