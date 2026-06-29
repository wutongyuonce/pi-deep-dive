/**
 * 会话 HTML 导出模块
 *
 * 作用/定位：将会话数据导出为独立的 HTML 文件，支持主题、自定义工具渲染。
 * 提供：exportSessionToHtml()（TUI /export 命令）、exportFromFile()（CLI 导出任意会话文件）。
 *
 * 模块结构：
 * - 会话数据收集（SessionManager → SessionData）
 * - 自定义工具预渲染（ToolHtmlRenderer → RenderedToolHtml）
 * - 主题变量生成（generateThemeVars / deriveExportColors）
 * - HTML 模板拼接（generateHtml：CSS + JS + 数据）
 *
 * 典型调用链路：
 *   exportSessionToHtml() → preRenderCustomTools() → generateHtml() → writeFileSync()
 *   exportFromFile() → SessionManager.open() → generateHtml() → writeFileSync()
 *
 * 被谁调用：TUI /export 命令、CLI export 子命令
 */

import type { AgentState } from "@earendil-works/pi-agent-core";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { APP_NAME, getExportTemplateDir } from "../../config.ts";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/interactive/theme/theme.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionEntry } from "../session-manager.ts";
import { SessionManager } from "../session-manager.ts";

/**
 * 自定义工具 HTML 渲染接口。
 * 由 agent-session 用于预渲染扩展工具输出。
 */
export interface ToolHtmlRenderer {
	/** 将工具调用渲染为 HTML。工具无自定义渲染器时返回 undefined。 */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** 将工具结果渲染为 HTML。返回折叠/展开版本，工具无自定义渲染器时返回 undefined。 */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/** 自定义工具调用和结果的预渲染 HTML */
interface RenderedToolHtml {
	callHtml?: string;
	resultHtmlCollapsed?: string;
	resultHtmlExpanded?: string;
}

export interface ExportOptions {
	outputPath?: string;
	themeName?: string;
	/** 可选的自定义工具渲染器 */
	toolRenderer?: ToolHtmlRenderer;
}

/**
 * 将颜色字符串解析为 RGB 值。支持十六进制（#RRGGBB）和 rgb(r,g,b) 格式。
 *
 * 被谁调用：getLuminance()、adjustBrightness()、deriveExportColors()
 */
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	// 先尝试解析十六进制格式，命中后直接返回 RGB 三元组。
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	// 再兼容 rgb(r,g,b) 形式，方便复用主题系统已经输出的颜色值。
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/**
 * 计算颜色的相对亮度（0-1，值越大越亮）。
 * 使用标准亮度公式：0.2126*R + 0.7152*G + 0.0722*B。
 * 用于判断主题是深色还是浅色模式。
 *
 * 被谁调用：deriveExportColors()
 */
function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * 调整颜色亮度。factor > 1 变亮，< 1 变暗。
 * 被谁调用：deriveExportColors()
 */
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	// 逐通道缩放亮度，并把结果钳制在合法的 0-255 范围内。
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/**
 * 从基础颜色（如 userMessageBg）推导导出背景色。
 * 根据颜色亮度（浅色/深色）采用不同的调整策略。
 *
 * 被谁调用：generateThemeVars()、generateHtml()
 */
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		// 无法解析主题色时回退到一组稳定的暗色导出配色。
		return {
			pageBg: "rgb(24, 24, 30)",
			cardBg: "rgb(30, 30, 36)",
			infoBg: "rgb(60, 55, 40)",
		};
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	const isLight = luminance > 0.5;

	if (isLight) {
		// 浅色主题只做轻微压暗，避免导出页过亮导致阅读疲劳。
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	// 深色主题则进一步拉开页面、卡片、信息块的明度层级。
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * 从主题颜色生成 CSS 自定义属性声明。
 * 优先使用主题显式定义的导出颜色，否则从 userMessageBg 推导。
 *
 * 被谁调用：generateHtml()
 */
function generateThemeVars(themeName?: string): string {
	const colors = getResolvedThemeColors(themeName);
	const lines: string[] = [];
	for (const [key, value] of Object.entries(colors)) {
		// 把主题对象逐项展开成 CSS 变量，交给模板直接消费。
		lines.push(`--${key}: ${value};`);
	}

	// 优先使用主题显式定义的导出颜色，否则从 userMessageBg 推导
	const themeExport = getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || "#343541";
	const derivedColors = deriveExportColors(userMessageBg);

	lines.push(`--exportPageBg: ${themeExport.pageBg ?? derivedColors.pageBg};`);
	lines.push(`--exportCardBg: ${themeExport.cardBg ?? derivedColors.cardBg};`);
	lines.push(`--exportInfoBg: ${themeExport.infoBg ?? derivedColors.infoBg};`);

	return lines.join("\n      ");
}

interface SessionData {
	header: ReturnType<SessionManager["getHeader"]>;
	entries: ReturnType<SessionManager["getEntries"]>;
	leafId: string | null;
	systemPrompt?: string;
	tools?: Array<Pick<ToolDefinition, "name" | "description" | "parameters">>;
	/** 自定义工具调用/结果的预渲染 HTML，以工具调用 ID 为键 */
	renderedTools?: Record<string, RenderedToolHtml>;
}

/**
 * 两个导出函数共用的核心 HTML 生成逻辑。
 *
 * 实现步骤：
 * 1. 读取模板文件（template.html、template.css、template.js）
 * 2. 读取第三方库（marked.min.js、highlight.min.js）
 * 3. 生成主题 CSS 变量
 * 4. 会话数据 Base64 编码后嵌入 HTML
 * 5. 将占位符替换为实际内容并返回完整 HTML
 *
 * 被谁调用：exportSessionToHtml()、exportFromFile()
 */
function generateHtml(sessionData: SessionData, themeName?: string): string {
	const templateDir = getExportTemplateDir();
	// 先把模板和第三方依赖完整读入，后续统一做字符串替换。
	const template = readFileSync(join(templateDir, "template.html"), "utf-8");
	const templateCss = readFileSync(join(templateDir, "template.css"), "utf-8");
	const templateJs = readFileSync(join(templateDir, "template.js"), "utf-8");
	const markedJs = readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf-8");
	const hljsJs = readFileSync(join(templateDir, "vendor", "highlight.min.js"), "utf-8");

	const themeVars = generateThemeVars(themeName);
	const colors = getResolvedThemeColors(themeName);
	const themeExport = getThemeExportColors(themeName);
	const derivedExportColors = deriveExportColors(colors.userMessageBg || "#343541");
	const bodyBg = themeExport.pageBg ?? derivedExportColors.pageBg;
	const containerBg = themeExport.cardBg ?? derivedExportColors.cardBg;
	const infoBg = themeExport.infoBg ?? derivedExportColors.infoBg;

	// 会话 JSON 先转 Base64，避免直接塞进 HTML 时被引号和换行破坏结构。
	const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");

	// 把主题变量和导出背景色补进 CSS 模板。
	const css = templateCss
		.replace("{{THEME_VARS}}", themeVars)
		.replace("{{BODY_BG}}", bodyBg)
		.replace("{{CONTAINER_BG}}", containerBg)
		.replace("{{INFO_BG}}", infoBg);

	return template
		.replace("{{CSS}}", css)
		.replace("{{JS}}", templateJs)
		.replace("{{SESSION_DATA}}", sessionDataBase64)
		.replace("{{MARKED_JS}}", markedJs)
		.replace("{{HIGHLIGHT_JS}}", hljsJs);
}

/** 由 HTML 模板直接渲染的工具（非通过 TUI→ANSI→HTML 管线预渲染） */
const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "edit", "ls"]);

/**
 * 使用工具的 TUI 渲染器将自定义工具预渲染为 HTML。
 *
 * 实现逻辑：
 * 1. 遍历所有会话条目
 * 2. 在助手消息中查找非模板渲染的工具调用（非 bash/read/write/edit/ls）
 * 3. 调用 toolRenderer.renderCall() 渲染工具调用
 * 4. 查找工具结果，调用 toolRenderer.renderResult() 渲染结果
 * 5. 以 toolCallId 为键存储预渲染的 HTML
 *
 * 被谁调用：exportSessionToHtml()
 */
function preRenderCustomTools(
	entries: SessionEntry[],
	toolRenderer: ToolHtmlRenderer,
): Record<string, RenderedToolHtml> {
	const renderedTools: Record<string, RenderedToolHtml> = {};

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		// 先从 assistant 消息里抓取需要自定义 HTML 的工具调用。
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall" && !TEMPLATE_RENDERED_TOOLS.has(block.name)) {
					const callHtml = toolRenderer.renderCall(block.id, block.name, block.arguments);
					if (callHtml) {
						renderedTools[block.id] = { callHtml };
					}
				}
			}
		}

		// 再把对应的工具结果补齐到同一个 toolCallId 记录里。
		if (msg.role === "toolResult" && msg.toolCallId) {
			const toolName = msg.toolName || "";
			// 只有自定义工具或已经渲染过调用头的工具，才继续生成结果 HTML。
			const existing = renderedTools[msg.toolCallId];
			if (existing || !TEMPLATE_RENDERED_TOOLS.has(toolName)) {
				const rendered = toolRenderer.renderResult(
					msg.toolCallId,
					toolName,
					msg.content,
					msg.details,
					msg.isError || false,
				);
				if (rendered) {
					renderedTools[msg.toolCallId] = {
						...existing,
						resultHtmlCollapsed: rendered.collapsed,
						resultHtmlExpanded: rendered.expanded,
					};
				}
			}
		}
	}

	return renderedTools;
}

/**
 * 使用 SessionManager 和 AgentState 导出会话为 HTML。
 * 由 TUI 的 /export 命令调用。
 *
 * 实现步骤：
 * 1. 检查会话文件是否存在
 * 2. 获取会话条目
 * 3. 如果提供工具渲染器，预渲染自定义工具
 * 4. 构建 SessionData 对象
 * 5. 调用 generateHtml() 生成 HTML
 * 6. 写入文件并返回路径
 *
 * 被谁调用：TUI 的 /export 命令处理器
 */
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionFile = sm.getSessionFile();
	if (!sessionFile) {
		throw new Error("Cannot export in-memory session to HTML");
	}
	if (!existsSync(sessionFile)) {
		throw new Error("Nothing to export yet - start a conversation first");
	}

	const entries = sm.getEntries();

	// 预渲染扩展工具，把 TUI 视图提前固化成 HTML，减少模板侧判断复杂度。
	let renderedTools: Record<string, RenderedToolHtml> | undefined;
	if (opts.toolRenderer) {
		renderedTools = preRenderCustomTools(entries, opts.toolRenderer);
		// 没有任何自定义渲染结果时，直接省掉这个字段以减小嵌入数据体积。
		if (Object.keys(renderedTools).length === 0) {
			renderedTools = undefined;
		}
	}

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries,
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt,
		tools: state?.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
		renderedTools,
	};

	const html = generateHtml(sessionData, opts.themeName);

	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		// 默认输出名跟随会话文件名，方便从多个导出文件中快速定位来源。
		const sessionBasename = basename(sessionFile, ".jsonl");
		outputPath = `${APP_NAME}-session-${sessionBasename}.html`;
	}

	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}

/**
 * 将会话文件导出为 HTML（独立模式，无需 AgentState）。
 * 由 CLI 用于导出任意会话文件。
 *
 * 实现步骤：
 * 1. 解析输入路径
 * 2. 检查文件存在
 * 3. 使用 SessionManager.open() 打开会话文件
 * 4. 构建 SessionData 对象（不含 systemPrompt 和 tools）
 * 5. 调用 generateHtml() 生成 HTML
 * 6. 写入文件并返回路径
 *
 * 被谁调用：CLI export 子命令
 */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};
	const resolvedInputPath = resolvePath(inputPath);

	if (!existsSync(resolvedInputPath)) {
		throw new Error(`File not found: ${resolvedInputPath}`);
	}

	const sm = SessionManager.open(resolvedInputPath);

	// 离线导出场景拿不到运行时状态，因此只嵌入会话基础数据。
	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: undefined,
		tools: undefined,
	};

	const html = generateHtml(sessionData, opts.themeName);

	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		// 默认文件名沿用输入会话名，避免导出结果互相覆盖。
		const inputBasename = basename(resolvedInputPath, ".jsonl");
		outputPath = `${APP_NAME}-session-${inputBasename}.html`;
	}

	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}
