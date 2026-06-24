/**
 * 扩展注册工具的包装器。
 *
 * 作用/定位：将扩展注册的 ToolDefinition 适配为 AgentTool，使扩展工具能被 AgentSession 使用。
 * 提供：wrapRegisteredTool()、wrapRegisteredTools() 两个函数。
 *
 * 这些包装器仅适配工具执行，使扩展工具能接收 runner 上下文。
 * 工具调用和工具结果的拦截由 AgentSession 通过 agent-core 钩子处理。
 *
 * 调用链路：wrapRegisteredTools() → wrapToolDefinitions() → AgentSession 使用
 * 被谁调用：session-manager 初始化、agent-session 工具注册
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition, wrapToolDefinitions } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * 将单个 RegisteredTool 包装为 AgentTool。
 * 使用 runner 的 createContext() 确保工具和事件处理器的上下文一致。
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return wrapToolDefinition(registeredTool.definition, () => runner.createContext());
}

/**
 * 将所有已注册工具批量包装为 AgentTool 数组。
 * 使用 runner 的 createContext() 确保工具和事件处理器的上下文一致。
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return wrapToolDefinitions(
		registeredTools.map((registeredTool) => registeredTool.definition),
		() => runner.createContext(),
	);
}
