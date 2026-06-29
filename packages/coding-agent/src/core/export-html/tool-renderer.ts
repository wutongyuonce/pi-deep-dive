/**
 * HTML 导出中自定义工具的 HTML 渲染器。
 *
 * 作用/定位：调用扩展工具注册的 TUI 渲染器（renderCall/renderResult），
 * 将输出的 ANSI 文本转换为 HTML。
 *
 * 核心类 createToolHtmlRenderer 返回 ToolHtmlRenderer 接口：
 * - renderCall()    — 渲染工具调用为 HTML
 * - renderResult()  — 渲染工具结果为折叠/展开两种 HTML 版本
 *
 * 调用链路：
 *   createToolHtmlRenderer() → getToolDefinition() → toolDef.renderCall/renderResult()
 *     → Component.render() → ansiLinesToHtml()
 *
 * 被谁调用：export-html/index.ts 的 exportSessionToHtml()
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderContext } from "../extensions/types.ts";
import { ansiLinesToHtml } from "./ansi-to-html.ts";

export interface ToolHtmlRendererDeps {
	/** Function to look up tool definition by name */
	getToolDefinition: (name: string) => ToolDefinition | undefined;
	/** Theme for styling */
	theme: Theme;
	/** Working directory for render context */
	cwd: string;
	/** Terminal width for rendering (default: 100) */
	width?: number;
}

export interface ToolHtmlRenderer {
	/** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** Render a tool result to collapsed/expanded HTML. Returns undefined if tool has no custom renderer. */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/**
 * 创建工具 HTML 渲染器。
 *
 * 实现逻辑：查找工具定义，调用其 renderCall/renderResult 方法，
 * 将 TUI 组件输出的 ANSI 文本转换为 HTML。
 * 维护渲染状态（组件缓存、状态缓存、参数缓存），支持增量更新。
 *
 * @param deps.getToolDefinition - 按名称查找工具定义的函数
 * @param deps.theme - 主题样式
 * @param deps.cwd - 工作目录
 * @param deps.width - 渲染宽度（默认 100）
 *
 * 被谁调用：export-html/index.ts 的 exportSessionToHtml()
 */
const ANSI_ESCAPE_REGEX = /\x1b\[[\d;]*m/g;

function isBlankRenderedLine(line: string): boolean {
	// 先剥掉 ANSI 颜色码，再判断这一行是否只剩空白字符。
	return line.replace(ANSI_ESCAPE_REGEX, "").trim().length === 0;
}

function trimRenderedResultLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	// 裁掉首尾纯空白行，避免导出的工具结果平白多出上下留白。
	while (start < end && isBlankRenderedLine(lines[start])) start++;
	while (end > start && isBlankRenderedLine(lines[end - 1])) end--;
	return lines.slice(start, end);
}

export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const { getToolDefinition, theme, cwd, width = 100 } = deps;

	const renderedCallComponents = new Map<string, Component>();
	const renderedResultComponents = new Map<string, Component>();
	const renderedStates = new Map<string, any>();
	const renderedArgs = new Map<string, unknown>();

	const getState = (toolCallId: string): any => {
		let state = renderedStates.get(toolCallId);
		if (!state) {
			// 同一 toolCall 的调用和结果渲染共享状态对象，便于增量渲染复用。
			state = {};
			renderedStates.set(toolCallId, state);
		}
		return state;
	};

	const createRenderContext = (
		toolCallId: string,
		lastComponent: Component | undefined,
		expanded: boolean,
		isPartial: boolean,
		isError: boolean,
	): ToolRenderContext => {
		// HTML 导出复用 TUI 渲染器时，需要手工补出一份最小 render context。
		return {
			args: renderedArgs.get(toolCallId),
			toolCallId,
			invalidate: () => {},
			lastComponent,
			state: getState(toolCallId),
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded,
			showImages: false,
			isError,
		};
	};

	return {
		renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined {
			try {
				renderedArgs.set(toolCallId, args);
				const toolDef = getToolDefinition(toolName);
				if (!toolDef?.renderCall) {
					return undefined;
				}

				// 先让工具生成 TUI 组件，再把组件渲染出的 ANSI 行转换成 HTML。
				const component = toolDef.renderCall(
					args,
					theme,
					createRenderContext(toolCallId, renderedCallComponents.get(toolCallId), false, true, false),
				);
				renderedCallComponents.set(toolCallId, component);
				const lines = component.render(width);
				return ansiLinesToHtml(lines);
			} catch {
				// 自定义渲染失败时回退到结构化默认渲染，避免整个导出中断。
				return undefined;
			}
		},

		renderResult(
			toolCallId: string,
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
		): { collapsed?: string; expanded?: string } | undefined {
			try {
				const toolDef = getToolDefinition(toolName);
				if (!toolDef?.renderResult) {
					return undefined;
				}

				// 先把会话里通用的 result 结构还原成工具渲染器期望的 AgentToolResult。
				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
				};

				// 先渲染折叠态，作为默认展示内容。
				const collapsedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: false, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), false, false, isError),
				);
				renderedResultComponents.set(toolCallId, collapsedComponent);
				const collapsed = ansiLinesToHtml(trimRenderedResultLines(collapsedComponent.render(width)));

				// 再渲染展开态；两者不同才输出可展开结构。
				const expandedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: true, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), true, false, isError),
				);
				renderedResultComponents.set(toolCallId, expandedComponent);
				const expanded = ansiLinesToHtml(trimRenderedResultLines(expandedComponent.render(width)));

				return {
					...(collapsed && collapsed !== expanded ? { collapsed } : {}),
					expanded,
				};
			} catch {
				// 自定义结果渲染失败时继续回退，保持 HTML 导出健壮。
				return undefined;
			}
		},
	};
}
