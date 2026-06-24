/**
 * 工具定义包装器 (tool-definition-wrapper.ts)
 *
 * 本文件提供 ToolDefinition（内部扩展定义）与 AgentTool（核心运行时接口）之间的双向转换。
 *
 * 定位：
 *   ToolDefinition 包含丰富的元信息（提示文本、渲染器等），而 AgentTool 是核心运行时
 *   所需的精简接口。本文件作为两者之间的桥梁。
 *
 * 提供的能力：
 *   1. wrapToolDefinition / wrapToolDefinitions：将 ToolDefinition → AgentTool
 *      - 在 execute 调用时注入 ExtensionContext（通过 ctxFactory）
 *   2. createToolDefinitionFromAgentTool：将 AgentTool → ToolDefinition
 *      - 用于将外部传入的 AgentTool 转为定义优先的注册格式
 *
 * 调用链路：
 *   各工具的 createXxxTool() → wrapToolDefinition(createXxxToolDefinition(...))
 *   AgentSession 注册时 → 可能调用 createToolDefinitionFromAgentTool 进行反向转换
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

/**
 * 将 ToolDefinition 包装为 AgentTool，供核心运行时使用。
 *
 * 在 execute 调用时，通过 ctxFactory 创建 ExtensionContext 并注入。
 * 被各工具的 createXxxTool() 工厂函数调用。
 *
 * @param definition  工具定义（包含完整元信息、渲染器等）
 * @param ctxFactory  可选的 ExtensionContext 工厂函数，每次执行时调用
 * @returns 符合 AgentTool 接口的工具实例
 */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
	};
}

/**
 * 批量将 ToolDefinition 数组包装为 AgentTool 数组。
 *
 * 调用 wrapToolDefinition 对每个定义进行转换。
 *
 * @param definitions  工具定义数组
 * @param ctxFactory   可选的 ExtensionContext 工厂函数
 * @returns AgentTool 数组
 */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * 从 AgentTool 反向创建最小化的 ToolDefinition。
 *
 * 用途：当调用方传入的是纯 AgentTool（不含提示元信息和渲染器）时，
 * 通过此函数将其转为定义格式，保持 AgentSession 内部注册表的一致性。
 *
 * @param tool  AgentTool 实例
 * @returns 最小化的 ToolDefinition（不含 promptSnippet、renderCall 等可选字段）
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
