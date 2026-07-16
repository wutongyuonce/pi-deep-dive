/**
 * Bedrock provider 模块导出。
 *
 * 文件定位：
 * - 这是 Amazon Bedrock 在 provider 装配层的极简桥接文件
 * - 负责把 `bedrock-converse-stream` API 模块暴露成统一的 provider module 结构
 *
 * 调用链路：
 * - 上层 provider 工厂或懒加载逻辑导入本文件
 * - 通过 `stream` / `streamSimple` 继续转到 `api/bedrock-converse-stream.ts`
 */

import { stream, streamSimple } from "./api/bedrock-converse-stream.ts";

/** Bedrock provider 的标准模块导出结构。 */
export const bedrockProviderModule = {
	stream,
	streamSimple,
};
