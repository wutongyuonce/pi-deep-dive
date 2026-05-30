/**
 * `packages/ai` 的公共入口文件。
 *
 * 定位：
 * - 这是 `@earendil-works/pi-ai` 包默认导出的 barrel file
 * - 外部调用方通常 `import { streamSimple, getModel, Type } from "@earendil-works/pi-ai"`
 *   时，最终都会先经过这里
 *
 * 谁会调用 / import 我：
 * - `packages/agent`：通过包名引入 `EventStream`、`streamSimple`、消息/模型类型等
 * - `packages/coding-agent`：通过包名引入 `streamSimple`、模型工具类型、校验工具等
 * - 仓库外部的 npm 使用者：把 `pi-ai` 当成独立库使用时，默认入口也是这里
 *
 * 为什么这样设计：
 * - 降低使用门槛：调用方不需要记内部文件路径
 * - 稳定公共 API：内部文件可以重构，外部 import 语句尽量保持不变
 * - 把“默认公共能力”和“provider 专属子入口”区分开
 */
export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

// 注册表层：provider / images provider 的注册与查询入口。
export * from "./api-registry.ts";
export * from "./env-api-keys.ts";
export * from "./image-models.ts";
export * from "./images.ts";
export * from "./images-api-registry.ts";
export * from "./models.ts";

// provider 专属 options 类型：
// 这里导出类型而不是整模块，目的是让外部可声明参数类型，
// 同时避免默认入口把每个 provider 的实现细节都暴露成顶层 API。
export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./providers/anthropic.ts";
export * from "./providers/faux.ts";

// 图片 provider 的内置注册入口，与文本 provider 分开维护。
export * from "./providers/images/register-builtins.ts";
export type { OpenAICompletionsOptions } from "./providers/openai-completions.ts";
export type { OpenAIResponsesOptions } from "./providers/openai-responses.ts";

// 文本 provider 的内置注册入口。
// `stream.ts` 在运行时会通过注册表找到真正的 provider。
export * from "./providers/register-builtins.ts";

// session 资源、统一流式入口、公共类型。
export * from "./session-resources.ts";
export * from "./stream.ts";
export * from "./types.ts";

// 通用工具：诊断、事件流、JSON 解析、overflow 与 schema/validation 工具。
export * from "./utils/diagnostics.ts";
export * from "./utils/event-stream.ts";
export * from "./utils/json-parse.ts";
export * from "./utils/overflow.ts";
export * from "./utils/typebox-helpers.ts";
export * from "./utils/validation.ts";
