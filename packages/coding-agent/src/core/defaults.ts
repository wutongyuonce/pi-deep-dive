/**
 * coding-agent 的全局默认常量。
 *
 * 文件定位：集中存放核心模块的默认配置值，被 model-resolver.ts 等模块引用。
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** 默认思考级别，当用户未显式指定时使用 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
