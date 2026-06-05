/**
 * `packages/ai` 的公共入口文件（barrel file）。
 *
 * 定位：
 * - 这是 `@earendil-works/pi-ai` 包默认导出的 barrel file
 * - 外部调用方 `import { streamSimple, getModel, Type } from "@earendil-works/pi-ai"`
 *   时，最终都会先经过这里
 *
 * 谁会 import 我：
 * - `packages/agent`：引入 EventStream、streamSimple、消息/模型类型等
 * - `packages/coding-agent`：引入 streamSimple、模型工具类型、校验工具等
 * - 仓库外部的 npm 使用者：把 `pi-ai` 当成独立库使用时，默认入口也是这里
 *
 * 为什么这样设计：
 * - 降低使用门槛：调用方不需要记内部文件路径
 * - 稳定公共 API：内部文件可以重构，外部 import 语句尽量保持不变
 * - 把"默认公共能力"和"provider 专属子入口"区分开
 */

// TypeBox 类型工具：用于定义 JSON Schema 和运行时类型验证。
export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

// ---------------------------------------------------------------------------
// 注册表层：provider / images provider 的注册与查询入口。
// ---------------------------------------------------------------------------

// API 注册表：文本 provider 的注册、查询、卸载。
export * from "./api-registry.ts";
// 环境变量 API 密钥读取。
export * from "./env-api-keys.ts";
// 图片模型注册表：查询图片模型元信息。
export * from "./image-models.ts";
// 图片生成统一入口：generateImages()。
export * from "./images.ts";
// 图片 API 注册表：图片 provider 的注册与查询。
export * from "./images-api-registry.ts";
// 文本模型注册表：查询文本模型元信息、计算费用、推理级别钳位。
export * from "./models.ts";

// ---------------------------------------------------------------------------
// Provider 专属 options 类型。
// 导出类型而不是整模块，目的是让外部可声明参数类型，
// 同时避免默认入口把每个 provider 的实现细节都暴露成顶层 API。
// ---------------------------------------------------------------------------

// Anthropic provider 的选项类型。
export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./providers/anthropic.ts";
// Faux 测试 provider：用于测试的模拟 provider，无需真实 API 密钥。
export * from "./providers/faux.ts";
// 图片 provider 的内置注册入口（副作用导入，与文本 provider 分开维护）。
export * from "./providers/images/register-builtins.ts";
// OpenAI Completions provider 的选项类型。
export type { OpenAICompletionsOptions } from "./providers/openai-completions.ts";
// OpenAI Responses provider 的选项类型。
export type { OpenAIResponsesOptions } from "./providers/openai-responses.ts";

// ---------------------------------------------------------------------------
// 文本 provider 的内置注册入口（副作用导入：模块加载时自动注册所有内置 provider）。
// `stream.ts` 在运行时会通过注册表找到真正的 provider。
// ---------------------------------------------------------------------------
export * from "./providers/register-builtins.ts";

// ---------------------------------------------------------------------------
// 公共能力：会话资源管理、统一流式入口、核心类型。
// ---------------------------------------------------------------------------

// 会话资源清理：注册/触发清理回调。
export * from "./session-resources.ts";
// 统一流式入口：stream() / streamSimple() / complete() / completeSimple()。
export * from "./stream.ts";
// 核心类型定义：Api、Model、Message、Content、Tool、Event 等。
export * from "./types.ts";

// ---------------------------------------------------------------------------
// 通用工具：诊断、事件流、JSON 解析、overflow 与 schema/validation 工具。
// ---------------------------------------------------------------------------

// 诊断信息工具。
export * from "./utils/diagnostics.ts";
// AssistantMessageEventStream 事件流实现。
export * from "./utils/event-stream.ts";
// JSON 解析工具（含修复和流式解析）。
export * from "./utils/json-parse.ts";
// overflow 处理工具。
export * from "./utils/overflow.ts";
// TypeBox 辅助工具。
export * from "./utils/typebox-helpers.ts";
// Schema 校验工具。
export * from "./utils/validation.ts";
