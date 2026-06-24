/**
 * @fileoverview 主题系统的核心实现模块。
 *
 * 文件定位：
 *   位于交互模式的 theme 子目录下，是整个 TUI 主题系统的基础。
 *   路径：packages/coding-agent/src/modes/interactive/theme/theme.ts
 *
 * 在调用链中的位置：
 *   - 被 interactive-mode.ts 在启动时调用 initTheme() 初始化全局主题
 *   - 被各 UI 组件（AssistantMessageComponent、ToolExecutionComponent 等）通过全局 theme 代理对象消费
 *   - 被 theme-selector.ts 调用 setTheme() / getAvailableThemes() 实现主题切换
 *   - 被 HTML 导出模块调用 getResolvedThemeColors() / getThemeExportColors() 获取 CSS 颜色
 *
 * 提供的能力：
 *   1. Theme 类：管理前景色/背景色 ANSI 映射，提供 fg/bg/bold/italic 等文本样式方法
 *   2. 主题加载：从内置主题（dark.json / light.json）和自定义主题目录加载 JSON 主题配置
 *   3. 变量解析：支持主题 JSON 中的 vars 变量引用（如 "primary" 代替具体色值）
 *   4. 颜色转换：hex 到 256 色映射、ANSI 转义序列生成、truecolor / 256color 双模式支持
 *   5. 终端背景检测：通过 COLORFGBG 环境变量判断终端是深色还是浅色背景
 *   6. 全局主题实例：通过 globalThis Symbol 跨模块加载器（tsx / jiti）共享同一主题状态
 *   7. 文件监听：自动监听自定义主题目录，文件变更时自动重载并通知 UI 刷新
 *   8. HTML 导出辅助：将主题颜色转为 CSS 兼容的 hex 格式
 *   9. TUI 辅助：生成 MarkdownTheme、SelectListTheme、EditorTheme、SettingsListTheme 等
 *
 * 与其他文件的关系：
 *   - config.ts：提供 getThemesDir() / getCustomThemesDir() 获取主题文件目录
 *   - source-info.ts：SourceInfo 类型用于标记主题来源信息
 *   - fs-watch.ts：提供 watchWithErrorHandler() / closeWatcher() 文件监听工具
 *   - syntax-highlight.ts：提供 highlight() / supportsLanguage() 代码高亮能力
 *   - @earendil-works/pi-tui：提供 MarkdownTheme / SelectListTheme / EditorTheme 等 TUI 主题接口
 *   - dark.json / light.json：内置主题 JSON 配置文件
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type EditorTheme,
	getCapabilities,
	type MarkdownTheme,
	type SelectListTheme,
	type SettingsListTheme,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { getCustomThemesDir, getThemesDir } from "../../../config.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import { closeWatcher, watchWithErrorHandler } from "../../../utils/fs-watch.ts";
import { highlight, supportsLanguage } from "../../../utils/syntax-highlight.ts";

// ============================================================================
// 类型定义与 JSON Schema 验证
// ============================================================================

/** 单个颜色值的 Schema：可以是字符串（hex 值如 "#ff0000"、变量引用如 "primary"、或空字符串 ""）或 0-255 的整数（256 色索引） */
const ColorValueSchema = Type.Union([
	Type.String(), // hex "#ff0000"、变量引用 "primary"、或空字符串 ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256 色索引
]);

/** 从 ColorValueSchema 推导出的 TypeScript 类型 */
type ColorValue = Static<typeof ColorValueSchema>;

/**
 * 主题 JSON 文件的完整 Schema 定义。
 * 用于验证用户自定义主题和内置主题的 JSON 结构。
 * 包含主题名称、可选的变量定义（vars）、颜色配置（colors）和导出配置（export）。
 */
const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	/** 可选的变量定义，用于颜色值复用（如定义 "primary": "#ff0000"，其他颜色可引用 "primary"） */
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// 核心 UI 颜色（10 色）
		accent: ColorValueSchema,
		border: ColorValueSchema,
		borderAccent: ColorValueSchema,
		borderMuted: ColorValueSchema,
		success: ColorValueSchema,
		error: ColorValueSchema,
		warning: ColorValueSchema,
		muted: ColorValueSchema,
		dim: ColorValueSchema,
		text: ColorValueSchema,
		thinkingText: ColorValueSchema,
		// 背景与内容文本颜色（11 色）
		selectedBg: ColorValueSchema,
		userMessageBg: ColorValueSchema,
		userMessageText: ColorValueSchema,
		customMessageBg: ColorValueSchema,
		customMessageText: ColorValueSchema,
		customMessageLabel: ColorValueSchema,
		toolPendingBg: ColorValueSchema,
		toolSuccessBg: ColorValueSchema,
		toolErrorBg: ColorValueSchema,
		toolTitle: ColorValueSchema,
		toolOutput: ColorValueSchema,
		// Markdown 渲染颜色（10 色）
		mdHeading: ColorValueSchema,
		mdLink: ColorValueSchema,
		mdLinkUrl: ColorValueSchema,
		mdCode: ColorValueSchema,
		mdCodeBlock: ColorValueSchema,
		mdCodeBlockBorder: ColorValueSchema,
		mdQuote: ColorValueSchema,
		mdQuoteBorder: ColorValueSchema,
		mdHr: ColorValueSchema,
		mdListBullet: ColorValueSchema,
		// 工具 Diff 颜色（3 色）
		toolDiffAdded: ColorValueSchema,
		toolDiffRemoved: ColorValueSchema,
		toolDiffContext: ColorValueSchema,
		// 语法高亮颜色（9 色）
		syntaxComment: ColorValueSchema,
		syntaxKeyword: ColorValueSchema,
		syntaxFunction: ColorValueSchema,
		syntaxVariable: ColorValueSchema,
		syntaxString: ColorValueSchema,
		syntaxNumber: ColorValueSchema,
		syntaxType: ColorValueSchema,
		syntaxOperator: ColorValueSchema,
		syntaxPunctuation: ColorValueSchema,
		// 思考级别边框颜色（6 色），对应不同的 thinking budget 级别
		thinkingOff: ColorValueSchema,
		thinkingMinimal: ColorValueSchema,
		thinkingLow: ColorValueSchema,
		thinkingMedium: ColorValueSchema,
		thinkingHigh: ColorValueSchema,
		thinkingXhigh: ColorValueSchema,
		// Bash 模式颜色（1 色）
		bashMode: ColorValueSchema,
	}),
	/**
	 * HTML 导出时的额外背景颜色配置。
	 * pageBg: 页面整体背景色
	 * cardBg: 卡片组件背景色
	 * infoBg: 信息提示区域背景色
	 */
	export: Type.Optional(
		Type.Object({
			pageBg: Type.Optional(ColorValueSchema),
			cardBg: Type.Optional(ColorValueSchema),
			infoBg: Type.Optional(ColorValueSchema),
		}),
	),
});

/** 主题 JSON 文件的 TypeScript 类型，从 ThemeJsonSchema 推导 */
type ThemeJson = Static<typeof ThemeJsonSchema>;

/** 编译后的主题 JSON 验证器，用于检查主题配置是否合法 */
const validateThemeJson = Compile(ThemeJsonSchema);

/**
 * 所有可用的前景色颜色令牌名称的联合类型。
 * 这些令牌对应 ThemeJsonSchema 中 colors 对象的各前景色字段。
 * 在组件中通过 theme.fg("accent", text) 方式使用。
 */
export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode";

/**
 * 所有可用的背景色颜色令牌名称的联合类型。
 * 这些令牌对应 ThemeJsonSchema 中 colors 对象的背景色字段。
 * 在组件中通过 theme.bg("selectedBg", text) 方式使用。
 */
export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

/**
 * 终端颜色模式。
 * - "truecolor"：24 位真彩色（#rrggbb），支持更丰富的颜色表现
 * - "256color"：256 色模式，兼容性更广但颜色精度较低
 */
type ColorMode = "truecolor" | "256color";

// ============================================================================
// 颜色工具函数
// ============================================================================

/**
 * 将十六进制颜色字符串转换为 RGB 分量。
 * 被 fgAnsi()、bgAnsi()、hexTo256() 等函数调用。
 *
 * @param hex - 十六进制颜色值，如 "#ff0000"
 * @returns 包含 r、g、b 分量（0-255）的对象
 * @throws 当 hex 格式无效时抛出错误
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
	// 移除 "#" 前缀并解析各分量
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	// 解析 RGB 各分量，每个分量占 2 个十六进制字符
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}

// 6x6x6 色彩立方体的通道值（索引 0-5 对应 ANSI 256 色索引 16-231）
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

// 灰度渐变值（索引 232-255，共 24 级灰度，从 8 到 238）
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

/**
 * 在 6x6x6 色彩立方体中找到与给定通道值最接近的索引（0-5）。
 * 被 rgbTo256() 调用。
 *
 * @param value - 单个通道的颜色值（0-255）
 * @returns 色彩立方体中最接近的索引（0-5）
 */
function findClosestCubeIndex(value: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < CUBE_VALUES.length; i++) {
		const dist = Math.abs(value - CUBE_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

/**
 * 在灰度渐变表中找到与给定灰度值最接近的索引（0-23）。
 * 被 rgbTo256() 调用。
 *
 * @param gray - 灰度值（0-255）
 * @returns 灰度渐变表中最接近的索引（0-23）
 */
function findClosestGrayIndex(gray: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < GRAY_VALUES.length; i++) {
		const dist = Math.abs(gray - GRAY_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

/**
 * 计算两个 RGB 颜色之间的加权欧氏距离。
 * 权重基于人眼对不同颜色通道的敏感度（对绿色最敏感，蓝色最不敏感）。
 * 被 rgbTo256() 调用来比较色彩立方体与灰度渐变的匹配程度。
 *
 * @param r1 - 颜色 1 的红色分量
 * @param g1 - 颜色 1 的绿色分量
 * @param b1 - 颜色 1 的蓝色分量
 * @param r2 - 颜色 2 的红色分量
 * @param g2 - 颜色 2 的绿色分量
 * @param b2 - 颜色 2 的蓝色分量
 * @returns 加权距离值（越小越接近）
 */
function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	// 加权欧氏距离（人眼对绿色更敏感，因此绿色权重最高）
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

/**
 * 将 RGB 颜色转换为最接近的 ANSI 256 色索引。
 * 算法在 6x6x6 色彩立方体（索引 16-231）和灰度渐变（索引 232-255）之间选择最佳匹配。
 * 对于有明显饱和度的颜色优先使用色彩立方体以保留色调。
 * 被 hexTo256() 调用。
 *
 * @param r - 红色分量（0-255）
 * @param g - 绿色分量（0-255）
 * @param b - 蓝色分量（0-255）
 * @returns ANSI 256 色索引
 */
function rgbTo256(r: number, g: number, b: number): number {
	// 在 6x6x6 色彩立方体中找到最近的颜色
	const rIdx = findClosestCubeIndex(r);
	const gIdx = findClosestCubeIndex(g);
	const bIdx = findClosestCubeIndex(b);
	// 计算色彩立方体中匹配色的 ANSI 索引和距离
	const cubeR = CUBE_VALUES[rIdx];
	const cubeG = CUBE_VALUES[gIdx];
	const cubeB = CUBE_VALUES[bIdx];
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx; // ANSI 256 色立方体索引公式
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

	// 在灰度渐变表中找到最近的灰度
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b); // 感知亮度公式
	const grayIdx = findClosestGrayIndex(gray);
	const grayValue = GRAY_VALUES[grayIdx];
	const grayIndex = 232 + grayIdx; // ANSI 256 色灰度索引
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

	// 检查颜色是否有明显饱和度（色调有意义）
	// 如果 max-min 差值显著，优先使用色彩立方体以保留色调
	const maxC = Math.max(r, g, b);
	const minC = Math.min(r, g, b);
	const spread = maxC - minC;

	// 只有当颜色接近中性（spread < 10）且灰度更接近时才选择灰度
	if (spread < 10 && grayDist < cubeDist) {
		return grayIndex;
	}

	return cubeIndex;
}

/**
 * 将十六进制颜色字符串转换为 ANSI 256 色索引。
 * 先通过 hexToRgb 转为 RGB，再通过 rgbTo256 映射到 256 色。
 * 被 fgAnsi() 和 bgAnsi() 在 256color 模式下调用。
 *
 * @param hex - 十六进制颜色值，如 "#ff0000"
 * @returns ANSI 256 色索引
 */
function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

/**
 * 生成前景色的 ANSI 转义序列。
 * 支持三种输入：空字符串（重置为默认前景色）、256 色索引、十六进制颜色值。
 * 被 Theme 构造函数调用，将颜色值预编译为 ANSI 序列。
 *
 * @param color - 颜色值：空字符串、256 色索引（数字）或 hex 字符串
 * @param mode - 颜色模式，truecolor 使用 24 位色，256color 使用 256 色
 * @returns ANSI 转义序列字符串
 * @throws 当颜色值无效时抛出错误
 */
function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m"; // 重置前景色为终端默认值
	if (typeof color === "number") return `\x1b[38;5;${color}m`; // 256 色前景色
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			// 使用 24 位真彩色前景色序列
			const { r, g, b } = hexToRgb(color);
			return `\x1b[38;2;${r};${g};${b}m`;
		} else {
			// 将 hex 转换为 256 色索引后设置前景色
			const index = hexTo256(color);
			return `\x1b[38;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

/**
 * 生成背景色的 ANSI 转义序列。
 * 逻辑与 fgAnsi() 类似，但使用背景色的 ANSI 转义码（48; 而非 38;）。
 * 被 Theme 构造函数调用，将背景颜色值预编译为 ANSI 序列。
 *
 * @param color - 颜色值：空字符串、256 色索引（数字）或 hex 字符串
 * @param mode - 颜色模式，truecolor 使用 24 位色，256color 使用 256 色
 * @returns ANSI 转义序列字符串
 * @throws 当颜色值无效时抛出错误
 */
function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m"; // 重置背景色为终端默认值
	if (typeof color === "number") return `\x1b[48;5;${color}m`; // 256 色背景色
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			// 使用 24 位真彩色背景色序列
			const { r, g, b } = hexToRgb(color);
			return `\x1b[48;2;${r};${g};${b}m`;
		} else {
			// 将 hex 转换为 256 色索引后设置背景色
			const index = hexTo256(color);
			return `\x1b[48;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

/**
 * 递归解析颜色值中的变量引用。
 * 主题 JSON 支持 vars 字段定义颜色变量（如 "primary": "#ff0000"），
 * colors 中的颜色可以引用这些变量名。此函数递归解析引用链直到得到最终色值。
 * 使用 visited 集合检测循环引用以防止无限递归。
 *
 * @param value - 待解析的颜色值（可能是变量名字符串、hex 值、256 色索引或空字符串）
 * @param vars - 变量定义映射表
 * @param visited - 已访问的变量名集合，用于循环引用检测
 * @returns 解析后的最终颜色值（字符串或数字）
 * @throws 当检测到循环引用或引用不存在的变量时抛出错误
 */
function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	// 如果是数字（256 色索引）、空字符串或 hex 值，直接返回无需解析
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	// 检测循环引用：如果该变量名已在当前解析路径中出现过，则报错
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value); // 标记当前变量为已访问，用于循环引用检测
	// 递归解析变量的值（变量可以引用其他变量）
	return resolveVarRefs(vars[value], vars, visited);
}

/**
 * 解析一组颜色定义中的所有变量引用。
 * 遍历 colors 对象的每个键值对，将变量引用替换为最终的颜色值。
 * 被 createTheme() 和 getResolvedThemeColors() 调用。
 *
 * @param colors - 颜色定义映射（键为颜色名，值为 ColorValue）
 * @param vars - 变量定义映射表
 * @returns 解析后的颜色映射（所有变量引用已替换为具体值）
 */
function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		// 对每个颜色值解析其变量引用
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

// ============================================================================
// Theme 类
// ============================================================================

/**
 * 主题类，管理终端文本的前景色、背景色和样式。
 * 构造时将所有颜色值预编译为 ANSI 转义序列并缓存在 Map 中，
 * 后续通过 fg/bg/bold 等方法直接拼接转义序列，避免重复计算。
 *
 * 通过全局 theme 代理对象（Proxy）被所有 UI 组件使用：
 *   theme.fg("accent", "高亮文本")
 *   theme.bg("selectedBg", "选中背景")
 *   theme.bold("粗体文本")
 */
export class Theme {
	/** 主题名称，如 "dark"、"light" 或自定义主题名 */
	readonly name?: string;
	/** 主题 JSON 文件的路径，内置主题和自定义主题均有此值 */
	readonly sourcePath?: string;
	/** 主题来源信息，用于标识主题来自内置、自定义还是注册 */
	sourceInfo?: SourceInfo;
	/** 前景色 ANSI 序列缓存：ThemeColor 令牌名 -> ANSI 转义序列 */
	private fgColors: Map<ThemeColor, string>;
	/** 背景色 ANSI 序列缓存：ThemeBg 令牌名 -> ANSI 转义序列 */
	private bgColors: Map<ThemeBg, string>;
	/** 当前颜色模式（truecolor 或 256color） */
	private mode: ColorMode;

	/**
	 * 构造 Theme 实例。
	 * 将所有前景色和背景色预编译为 ANSI 转义序列。
	 *
	 * @param fgColors - 前景色映射（颜色令牌名 -> 颜色值）
	 * @param bgColors - 背景色映射（颜色令牌名 -> 颜色值）
	 * @param mode - 颜色模式
	 * @param options - 可选配置，包含主题名称、来源路径和来源信息
	 */
	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		mode: ColorMode,
		options: { name?: string; sourcePath?: string; sourceInfo?: SourceInfo } = {},
	) {
		this.name = options.name;
		this.sourcePath = options.sourcePath;
		this.sourceInfo = options.sourceInfo;
		this.mode = mode;
		// 预编译所有前景色为 ANSI 转义序列并缓存
		this.fgColors = new Map();
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
			this.fgColors.set(key, fgAnsi(value, mode));
		}
		// 预编译所有背景色为 ANSI 转义序列并缓存
		this.bgColors = new Map();
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.bgColors.set(key, bgAnsi(value, mode));
		}
	}

	/**
	 * 使用指定前景色渲染文本。
	 * 返回带有 ANSI 前景色转义序列的文本，末尾自动重置前景色。
	 * 被所有 UI 组件广泛调用，如 theme.fg("accent", "高亮文本")。
	 *
	 * @param color - 前景色令牌名
	 * @param text - 要渲染的文本
	 * @returns 带 ANSI 转义序列的文本
	 * @throws 当颜色令牌不存在时抛出错误
	 */
	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // 仅重置前景色，不影响背景色
	}

	/**
	 * 使用指定背景色渲染文本。
	 * 返回带有 ANSI 背景色转义序列的文本，末尾自动重置背景色。
	 *
	 * @param color - 背景色令牌名
	 * @param text - 要渲染的文本
	 * @returns 带 ANSI 转义序列的文本
	 * @throws 当背景色令牌不存在时抛出错误
	 */
	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // 仅重置背景色，不影响前景色
	}

	/**
	 * 将文本渲染为粗体样式。
	 * 委托给 chalk.bold()。
	 *
	 * @param text - 要渲染的文本
	 * @returns 带 ANSI 粗体转义序列的文本
	 */
	bold(text: string): string {
		return chalk.bold(text);
	}

	/**
	 * 将文本渲染为斜体样式。
	 * 委托给 chalk.italic()。
	 *
	 * @param text - 要渲染的文本
	 * @returns 带 ANSI 斜体转义序列的文本
	 */
	italic(text: string): string {
		return chalk.italic(text);
	}

	/**
	 * 将文本渲染为下划线样式。
	 * 委托给 chalk.underline()。
	 *
	 * @param text - 要渲染的文本
	 * @returns 带 ANSI 下划线转义序列的文本
	 */
	underline(text: string): string {
		return chalk.underline(text);
	}

	/**
	 * 将文本渲染为反色样式（前景色与背景色互换）。
	 * 委托给 chalk.inverse()。
	 *
	 * @param text - 要渲染的文本
	 * @returns 带 ANSI 反色转义序列的文本
	 */
	inverse(text: string): string {
		return chalk.inverse(text);
	}

	/**
	 * 将文本渲染为删除线样式。
	 * 委托给 chalk.strikethrough()。
	 *
	 * @param text - 要渲染的文本
	 * @returns 带 ANSI 删除线转义序列的文本
	 */
	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	/**
	 * 获取指定前景色令牌的原始 ANSI 转义序列。
	 * 与 fg() 不同，不包裹文本也不添加重置序列。
	 * 用于需要手动控制转义序列的场景。
	 *
	 * @param color - 前景色令牌名
	 * @returns ANSI 转义序列字符串
	 * @throws 当颜色令牌不存在时抛出错误
	 */
	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	/**
	 * 获取指定背景色令牌的原始 ANSI 转义序列。
	 * 与 bg() 不同，不包裹文本也不添加重置序列。
	 *
	 * @param color - 背景色令牌名
	 * @returns ANSI 转义序列字符串
	 * @throws 当背景色令牌不存在时抛出错误
	 */
	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	/**
	 * 获取当前主题的颜色模式。
	 *
	 * @returns 当前颜色模式（"truecolor" 或 "256color"）
	 */
	getColorMode(): ColorMode {
		return this.mode;
	}

	/**
	 * 根据 thinking budget 级别获取对应的边框着色函数。
	 * 每个思考级别（off/minimal/low/medium/high/xhigh）对应不同的主题颜色。
	 * 被 ThinkingSelectorComponent 和 thinking 相关 UI 组件调用。
	 *
	 * @param level - 思考级别
	 * @returns 着色函数，接受文本字符串返回带颜色的文本
	 */
	getThinkingBorderColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): (str: string) => string {
		// 将思考级别映射到专用的主题颜色令牌
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	/**
	 * 获取 Bash 模式的边框着色函数。
	 * 返回使用 bashMode 颜色令牌的着色函数。
	 * 被 BashExecutionComponent 调用。
	 *
	 * @returns 着色函数，接受文本字符串返回带颜色的文本
	 */
	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}
}

// ============================================================================
// 主题加载
// ============================================================================

/** 内置主题缓存，首次访问时从磁盘加载 dark.json 和 light.json */
let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

/**
 * 获取内置主题映射表（懒加载）。
 * 从 themesDir 目录读取 dark.json 和 light.json 并缓存。
 * 被 loadThemeJson()、getAvailableThemesWithPaths() 等函数调用。
 *
 * @returns 内置主题名到 ThemeJson 的映射
 */
function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		// 从配置获取内置主题目录
		const themesDir = getThemesDir();
		const darkPath = path.join(themesDir, "dark.json");
		const lightPath = path.join(themesDir, "light.json");
		BUILTIN_THEMES = {
			dark: JSON.parse(fs.readFileSync(darkPath, "utf-8")) as ThemeJson,
			light: JSON.parse(fs.readFileSync(lightPath, "utf-8")) as ThemeJson,
		};
	}
	return BUILTIN_THEMES;
}

/**
 * 获取所有可用主题的名称列表。
 * 被 ThemeSelectorComponent 调用以展示可选主题列表。
 *
 * @returns 主题名称数组
 */
export function getAvailableThemes(): string[] {
	return getAvailableThemesWithPaths().map(({ name }) => name);
}

/**
 * 主题信息接口，包含主题名称和对应的文件路径。
 */
export interface ThemeInfo {
	/** 主题名称 */
	name: string;
	/** 主题文件路径，注册主题可能没有路径 */
	path: string | undefined;
}

/**
 * 获取所有可用主题的详细信息（名称和路径）。
 * 合并内置主题、自定义主题目录中的主题和通过 setRegisteredThemes() 注册的主题。
 * 结果按名称字母排序，同名主题去重（优先保留先添加的）。
 * 被 getAvailableThemes() 调用。
 *
 * @returns 主题信息数组
 */
export function getAvailableThemesWithPaths(): ThemeInfo[] {
	// 从配置获取内置主题目录
	const themesDir = getThemesDir();
	const result: ThemeInfo[] = [];
	// 用于去重：同名主题只保留第一个
	const seen = new Set<string>();
	/** 添加主题到结果列表，自动去重 */
	const addTheme = (themeInfo: ThemeInfo) => {
		if (seen.has(themeInfo.name)) {
			return;
		}
		seen.add(themeInfo.name);
		result.push(themeInfo);
	};

	// 内置主题（dark、light）
	for (const name of Object.keys(getBuiltinThemes())) {
		addTheme({ name, path: path.join(themesDir, `${name}.json`) });
	}

	// 自定义主题（来自用户自定义主题目录）
	for (const themeInfo of getCustomThemeInfos()) {
		addTheme(themeInfo);
	}

	for (const [name, theme] of registeredThemes.entries()) {
		addTheme({ name, path: theme.sourcePath });
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 获取自定义主题目录中的主题信息列表。
 * 扫描自定义主题目录下的所有 .json 文件，解析每个主题的名称。
 * 无效的主题文件会被静默忽略（错误在正常启动/重载时由资源加载器报告）。
 * 被 getAvailableThemesWithPaths() 调用。
 *
 * @returns 自定义主题信息数组
 */
function getCustomThemeInfos(): ThemeInfo[] {
	const customThemesDir = getCustomThemesDir();
	const result: ThemeInfo[] = [];
	if (!fs.existsSync(customThemesDir)) {
		return result;
	}

	for (const file of fs.readdirSync(customThemesDir)) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const themePath = path.join(customThemesDir, file);
		try {
			const customTheme = loadThemeFromPath(themePath);
			if (customTheme.name) {
				result.push({ name: customTheme.name, path: themePath });
			}
		} catch {
			// 无效主题在此处忽略；错误会在正常启动/重载时由资源加载器报告
		}
	}
	return result;
}

/**
 * 验证并解析主题 JSON 数据。
 * 使用 typebox 编译的验证器检查 JSON 结构，提供详细的错误信息（包括缺失的颜色令牌列表）。
 * 被 parseThemeJsonContent() 调用。
 *
 * @param label - 主题标识名称，用于错误信息中的主题引用
 * @param json - 待验证的原始 JSON 数据
 * @returns 验证通过的 ThemeJson 对象
 * @throws 当 JSON 结构不合法时抛出包含详细错误信息的错误
 */
function parseThemeJson(label: string, json: unknown): ThemeJson {
	if (!validateThemeJson.Check(json)) {
		const errors = Array.from(validateThemeJson.Errors(json));
		const missingColors = new Set<string>();
		const otherErrors: string[] = [];

		for (const error of errors) {
			if (error.keyword === "required" && error.instancePath === "/colors") {
				const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
				for (const requiredProperty of requiredProperties ?? []) {
					missingColors.add(requiredProperty);
				}
				continue;
			}

			const path = error.instancePath || "/";
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.size > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += Array.from(missingColors)
				.sort()
				.map((color) => `  - ${color}`)
				.join("\n");
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	return json as ThemeJson;
}

/**
 * 从 JSON 字符串内容解析并验证主题配置。
 * 先将字符串解析为 JSON，再调用 parseThemeJson() 进行结构验证。
 * 被 loadThemeJson() 和 loadThemeFromPath() 调用。
 *
 * @param label - 主题标识名称，用于错误信息
 * @param content - JSON 格式的主题配置字符串
 * @returns 验证通过的 ThemeJson 对象
 * @throws 当 JSON 解析失败或结构不合法时抛出错误
 */
function parseThemeJsonContent(label: string, content: string): ThemeJson {
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${label}: ${error}`);
	}
	return parseThemeJson(label, json);
}

/**
 * 根据主题名称加载 ThemeJson 配置。
 * 查找顺序：内置主题缓存 -> 注册主题（通过 setRegisteredThemes）-> 自定义主题目录文件。
 * 被 loadTheme() 和 getResolvedThemeColors() 调用。
 *
 * @param name - 主题名称
 * @returns 解析后的 ThemeJson 对象
 * @throws 当主题不存在或无法加载时抛出错误
 */
function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme?.sourcePath) {
		const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
		return parseThemeJsonContent(registeredTheme.sourcePath, content);
	}
	if (registeredTheme) {
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	return parseThemeJsonContent(name, content);
}

/**
 * 从 ThemeJson 配置创建 Theme 实例。
 * 解析变量引用，将颜色分为前景色和背景色两组，然后构建 Theme 对象。
 * 如果未指定颜色模式，自动根据终端能力选择 truecolor 或 256color。
 * 被 loadTheme() 和 loadThemeFromPath() 调用。
 *
 * @param themeJson - 主题 JSON 配置
 * @param mode - 可选的颜色模式，不指定时自动检测
 * @param sourcePath - 可选的主题文件路径
 * @returns 新创建的 Theme 实例
 */
function createTheme(themeJson: ThemeJson, mode?: ColorMode, sourcePath?: string): Theme {
	const colorMode = mode ?? (getCapabilities().trueColor ? "truecolor" : "256color");
	const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);
	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	const bgColorKeys: Set<string> = new Set([
		"selectedBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
	]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return new Theme(fgColors, bgColors, colorMode, {
		name: themeJson.name,
		sourcePath,
	});
}

/**
 * 从指定文件路径加载并创建 Theme 实例。
 * 读取文件内容，解析 JSON 配置后构建 Theme 对象。
 * 被主题文件监视器（startThemeWatcher）和外部模块调用。
 *
 * @param themePath - 主题 JSON 文件的绝对路径
 * @param mode - 可选的颜色模式
 * @returns 加载完成的 Theme 实例
 * @throws 当文件不存在或内容无效时抛出错误
 */
export function loadThemeFromPath(themePath: string, mode?: ColorMode): Theme {
	const content = fs.readFileSync(themePath, "utf-8");
	const themeJson = parseThemeJsonContent(themePath, content);
	return createTheme(themeJson, mode, themePath);
}

/**
 * 根据主题名称加载并创建 Theme 实例。
 * 优先查找注册主题（直接返回实例），否则通过 loadThemeJson() 获取配置并创建。
 * 被 initTheme()、setTheme() 和 getThemeByName() 调用。
 *
 * @param name - 主题名称
 * @param mode - 可选的颜色模式
 * @returns 加载完成的 Theme 实例
 * @throws 当主题不存在或配置无效时抛出错误
 */
function loadTheme(name: string, mode?: ColorMode): Theme {
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme) {
		return registeredTheme;
	}
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode);
}

/**
 * 根据主题名称获取 Theme 实例，加载失败时返回 undefined 而非抛出异常。
 * 供外部模块安全查询主题，如主题选择器预览。
 *
 * @param name - 主题名称
 * @returns Theme 实例，加载失败时返回 undefined
 */
export function getThemeByName(name: string): Theme | undefined {
	try {
		return loadTheme(name);
	} catch {
		return undefined;
	}
}

/**
 * 终端主题类型。
 * - "dark"：深色主题，适用于深色背景终端
 * - "light"：浅色主题，适用于浅色背景终端
 */
export type TerminalTheme = "dark" | "light";

/**
 * RGB 颜色值，每个分量范围为 0-255。
 * 用于终端背景颜色检测和亮度计算。
 */
export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

/**
 * 终端主题检测结果。
 * 包含检测到的主题类型、检测来源、详细说明和置信度。
 * 被 detectTerminalBackground() 返回。
 */
export interface TerminalThemeDetection {
	/** 检测到的终端主题类型 */
	theme: TerminalTheme;
	/** 检测来源：终端背景色查询、COLORFGBG 环境变量或默认回退 */
	source: "terminal background" | "COLORFGBG" | "fallback";
	/** 检测过程的详细说明 */
	detail: string;
	/** 检测结果的置信度：high 表示可靠检测，low 表示仅为回退默认值 */
	confidence: "high" | "low";
}

/**
 * 终端主题检测选项。
 * 用于自定义检测过程中的环境变量读取方式（便于测试）。
 */
export interface TerminalThemeDetectionOptions {
	/** 自定义环境变量对象，默认使用 process.env */
	env?: NodeJS.ProcessEnv;
}

/**
 * 从 COLORFGBG 环境变量中解析终端背景色索引。
 * COLORFGBG 格式通常为 "fg;bg" 或 "fg;bg;app"，从后向前查找第一个合法的 0-255 整数。
 * 被 detectTerminalBackground() 调用。
 *
 * @param colorfgbg - COLORFGBG 环境变量的值
 * @returns 背景色的 ANSI 256 色索引，解析失败时返回 undefined
 */
function getColorFgBgBackgroundIndex(colorfgbg: string): number | undefined {
	const parts = colorfgbg.split(";");
	for (let i = parts.length - 1; i >= 0; i--) {
		const bg = parseInt(parts[i].trim(), 10);
		if (Number.isInteger(bg) && bg >= 0 && bg <= 255) {
			return bg;
		}
	}
	return undefined;
}

/**
 * 计算 RGB 颜色的相对亮度值（WCAG 标准）。
 * 使用 sRGB 到线性色彩空间的转换公式，返回值范围为 0（纯黑）到 1（纯白）。
 * 被 getThemeForRgbColor() 和 detectTerminalBackground() 间接调用。
 *
 * @param rgb - RGB 颜色对象
 * @returns 相对亮度值（0-1）
 */
function getRgbColorLuminance({ r, g, b }: RgbColor): number {
	const toLinear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * 计算 ANSI 256 色索引对应颜色的相对亮度。
 * 先将 256 色索引转换为 hex 值，再转换为 RGB，最后计算亮度。
 * 被 detectTerminalBackground() 调用。
 *
 * @param index - ANSI 256 色索引（0-255）
 * @returns 相对亮度值（0-1）
 */
function getAnsiColorLuminance(index: number): number {
	return getRgbColorLuminance(hexToRgb(ansi256ToHex(index)));
}

/**
 * 根据 RGB 颜色亮度判断应使用深色还是浅色主题。
 * 亮度 >= 0.5 判定为浅色主题，否则为深色主题。
 * 供外部模块直接调用，如需要根据特定颜色选择主题的场景。
 *
 * @param rgb - RGB 颜色对象
 * @returns "light" 或 "dark"
 */
export function getThemeForRgbColor(rgb: RgbColor): TerminalTheme {
	return getRgbColorLuminance(rgb) >= 0.5 ? "light" : "dark";
}

/**
 * 解析 OSC 转义序列中的十六进制颜色分量。
 * 处理可变长度的十六进制字符串（如 4 位或 16 位），归一化到 0-255 范围。
 * 被 parseOsc11BackgroundColor() 调用。
 *
 * @param channel - 十六进制颜色分量字符串（如 "ffff" 或 "ff"）
 * @returns 归一化后的 0-255 整数值，解析失败时返回 undefined
 */
function parseOscHexChannel(channel: string): number | undefined {
	if (!/^[0-9a-f]+$/i.test(channel)) {
		return undefined;
	}
	const max = 16 ** channel.length - 1;
	if (max <= 0) {
		return undefined;
	}
	return Math.round((parseInt(channel, 16) / max) * 255);
}

/**
 * 解析终端 OSC 11 转义序列中的背景颜色。
 * OSC 11 是终端标准的"查询/报告背景颜色"序列，支持多种格式：
 * - 6 位 hex（#rrggbb）
 * - 12 位 hex（#rrrrggggbbbb，高精度）
 * - rgb 格式（rgb:rrrr/gggg/bbbb）
 * 供外部模块调用，用于精确检测终端背景色。
 *
 * @param data - 终端返回的 OSC 11 原始响应数据
 * @returns 解析后的 RGB 颜色对象，解析失败时返回 undefined
 */
export function parseOsc11BackgroundColor(data: string): RgbColor | undefined {
	const match = data.match(/^\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)$/i);
	if (!match) {
		return undefined;
	}

	const value = match[1].trim();
	if (value.startsWith("#")) {
		const hex = value.slice(1);
		if (/^[0-9a-f]{6}$/i.test(hex)) {
			return hexToRgb(value);
		}
		if (/^[0-9a-f]{12}$/i.test(hex)) {
			const r = parseOscHexChannel(hex.slice(0, 4));
			const g = parseOscHexChannel(hex.slice(4, 8));
			const b = parseOscHexChannel(hex.slice(8, 12));
			return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
		}
		return undefined;
	}

	const rgbValue = value.replace(/^rgba?:/i, "");
	const [red, green, blue] = rgbValue.split("/");
	if (red === undefined || green === undefined || blue === undefined) {
		return undefined;
	}
	const r = parseOscHexChannel(red);
	const g = parseOscHexChannel(green);
	const b = parseOscHexChannel(blue);
	return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
}

/**
 * 检测终端背景类型（深色或浅色）。
 * 当前仅通过 COLORFGBG 环境变量判断，未来可扩展 OSC 11 查询。
 * 被 getDefaultTheme() 调用，也供外部模块获取详细的检测信息。
 *
 * @param options - 检测选项，可自定义环境变量读取方式
 * @returns 检测结果，包含主题类型、来源、详情和置信度
 */
export function detectTerminalBackground(options: TerminalThemeDetectionOptions = {}): TerminalThemeDetection {
	const env = options.env ?? process.env;
	const colorfgbg = env.COLORFGBG || "";
	const bg = getColorFgBgBackgroundIndex(colorfgbg);
	if (bg !== undefined) {
		return {
			theme: getAnsiColorLuminance(bg) >= 0.5 ? "light" : "dark",
			source: "COLORFGBG",
			detail: `background color index ${bg}`,
			confidence: "high",
		};
	}

	return {
		theme: "dark",
		source: "fallback",
		detail: "no terminal background hint found",
		confidence: "low",
	};
}

/**
 * 获取默认主题名称（基于终端背景自动检测）。
 * 如果终端是浅色背景返回 "light"，否则返回 "dark"。
 * 被 initTheme() 在未指定主题名称时调用。
 *
 * @returns "dark" 或 "light"
 */
export function getDefaultTheme(): string {
	return detectTerminalBackground().theme;
}

// ============================================================================
// 全局主题实例
// ============================================================================

// 使用 globalThis 跨模块加载器（tsx + jiti 开发模式）共享主题实例
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

// 通过 Proxy 导出 theme，从 globalThis 读取实际主题实例
// 确保所有模块实例（tsx、jiti）访问的是同一个主题状态
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

/**
 * 将 Theme 实例写入 globalThis，使所有模块加载器共享同一主题。
 * 同时写入新旧两个 Symbol key 以兼容不同版本的加载器。
 * 被 initTheme()、setTheme()、setThemeInstance() 和 startThemeWatcher() 调用。
 *
 * @param t - 要设置为全局的 Theme 实例
 */
function setGlobalTheme(t: Theme): void {
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
	(globalThis as Record<symbol, Theme>)[THEME_KEY_OLD] = t;
}

/** 当前激活的主题名称，用于主题切换和文件监视器匹配 */
let currentThemeName: string | undefined;
/** 自定义主题文件的文件系统监视器实例 */
let themeWatcher: fs.FSWatcher | undefined;
/** 主题重载防抖定时器，避免文件编辑过程中频繁重载 */
let themeReloadTimer: NodeJS.Timeout | undefined;
/** 主题变更回调函数，主题切换后通知 UI 刷新 */
let onThemeChangeCallback: (() => void) | undefined;
/** 已注册主题映射表，存储通过 setRegisteredThemes() 注册的外部主题 */
const registeredThemes = new Map<string, Theme>();

/**
 * 注册外部提供的主题实例。
 * 这些主题优先于内置主题和自定义主题文件被查找。
 * 被外部扩展模块调用以注入自定义主题。
 *
 * @param themes - 要注册的 Theme 实例数组
 */
export function setRegisteredThemes(themes: Theme[]): void {
	registeredThemes.clear();
	for (const theme of themes) {
		if (theme.name) {
			registeredThemes.set(theme.name, theme);
		}
	}
}

/**
 * 初始化全局主题。
 * 在交互模式启动时由 interactive-mode.ts 调用。
 * 如果未指定主题名称，自动根据终端背景检测选择 dark 或 light。
 * 加载失败时静默回退到 dark 主题。
 *
 * @param themeName - 可选的主题名称，不指定时自动检测
 * @param enableWatcher - 是否启用自定义主题文件监视（开发模式下使用）
 */
export function initTheme(themeName?: string, enableWatcher: boolean = false): void {
	const name = themeName ?? getDefaultTheme();
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
	} catch (_error) {
		// 主题无效，静默回退到 dark 主题
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark"));
		// 回退主题不启动文件监视器
	}
}

/**
 * 切换全局主题。
 * 被 ThemeSelectorComponent 调用实现主题热切换。
 * 加载失败时回退到 dark 主题，并返回错误信息。
 *
 * @param name - 目标主题名称
 * @param enableWatcher - 是否启用自定义主题文件监视
 * @returns 操作结果，包含 success 标志和可选的 error 消息
 */
export function setTheme(name: string, enableWatcher: boolean = false): { success: boolean; error?: string } {
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
		return { success: true };
	} catch (error) {
		// 主题无效，回退到 dark 主题
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark"));
		// 回退主题不启动文件监视器
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * 直接设置内存中的 Theme 实例为全局主题。
 * 用于外部模块绕过文件加载直接注入主题（如测试或运行时生成的主题）。
 * 直接实例无法被文件监视器跟踪，因此会停止监视器。
 *
 * @param themeInstance - 要设置的 Theme 实例
 */
export function setThemeInstance(themeInstance: Theme): void {
	setGlobalTheme(themeInstance);
	currentThemeName = "<in-memory>";
	stopThemeWatcher(); // 直接实例无法被文件监视器跟踪
	if (onThemeChangeCallback) {
		onThemeChangeCallback();
	}
}

/**
 * 注册主题变更回调函数。
 * 当主题切换或自动重载后，该回调被调用以通知 UI 层刷新。
 * 被 interactive-mode.ts 在启动时注册。
 *
 * @param callback - 主题变更时执行的回调函数
 */
export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
}

/**
 * 启动自定义主题文件监视器。
 * 监视自定义主题目录，当当前主题的 JSON 文件被修改时自动重载。
 * 内置主题（dark/light）不触发监视。使用 100ms 防抖避免编辑过程中频繁重载。
 * 被 initTheme() 和 setTheme() 在 enableWatcher 为 true 时调用。
 */
function startThemeWatcher(): void {
	stopThemeWatcher();

	// 仅监视自定义主题，内置主题（dark/light）不需要监视
	if (!currentThemeName || currentThemeName === "dark" || currentThemeName === "light") {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	// 仅在主题文件存在时启动监视
	if (!fs.existsSync(themeFile)) {
		return;
	}

	/**
	 * 调度主题重载，带 100ms 防抖。
	 * 文件编辑过程中可能触发多次变更事件，防抖确保只在编辑完成后重载一次。
	 */
	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			// 忽略主题切换或停止监视后的过期定时器
			if (currentThemeName !== watchedThemeName) {
				return;
			}

			// 文件暂时缺失时保持上次成功加载的主题，避免编辑中间态报错
			if (!fs.existsSync(themeFile)) {
				return;
			}

			try {
				// 从磁盘重新加载主题并刷新注册缓存
				const reloadedTheme = loadThemeFromPath(themeFile);
				registeredThemes.set(watchedThemeName, reloadedTheme);
				setGlobalTheme(reloadedTheme);
				// 通知回调以触发 UI 刷新
				if (onThemeChangeCallback) {
					onThemeChangeCallback();
				}
			} catch (_error) {
				// 忽略错误（文件可能正处于编辑中间态）
			}
		}, 100);
	};

	themeWatcher =
		watchWithErrorHandler(
			customThemesDir,
			(_eventType, filename) => {
				if (currentThemeName !== watchedThemeName) {
					return;
				}
				if (!filename) {
					scheduleReload();
					return;
				}
				if (filename !== watchedFileName) {
					return;
				}
				scheduleReload();
			},
			() => {
				closeWatcher(themeWatcher);
				themeWatcher = undefined;
			},
		) ?? undefined;
}

/**
 * 停止主题文件监视器并清理相关资源。
 * 清除防抖定时器，关闭文件系统监视器。
 * 被 setThemeInstance()、startThemeWatcher() 和应用退出时调用。
 */
export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	closeWatcher(themeWatcher);
	themeWatcher = undefined;
}

// ============================================================================
// HTML 导出辅助
// ============================================================================

/**
 * 将 ANSI 256 色索引转换为十六进制颜色字符串。
 * 索引 0-15：基本颜色（近似常用终端默认值）
 * 索引 16-231：6x6x6 色彩立方体
 * 索引 232-255：24 级灰度渐变
 * 被 getResolvedThemeColors()、getThemeExportColors() 和 getAnsiColorLuminance() 调用。
 *
 * @param index - ANSI 256 色索引（0-255）
 * @returns 十六进制颜色字符串，如 "#ff0000"
 */
function ansi256ToHex(index: number): string {
	// 基本颜色（0-15）- 近似常用终端默认值
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// 色彩立方体（16-231）：6x6x6 = 216 色
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// 灰度渐变（232-255）：24 级灰度
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * 获取已解析的主题颜色，输出为 CSS 兼容的十六进制字符串。
 * 用于 HTML 导出功能，将主题颜色转为 CSS 自定义属性。
 * 被 HTML 导出模块调用。
 *
 * @param themeName - 可选的主题名称，不指定时使用当前主题
 * @returns 颜色名到十六进制字符串的映射
 */
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	const isLight = name === "light";
	const themeJson = loadThemeJson(name);
	const resolved = resolveThemeColors(themeJson.colors, themeJson.vars);

	// 空值对应的默认文本颜色（终端使用默认前景色，HTML 需要明确值）
	const defaultText = isLight ? "#000000" : "#e5e5e7";

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// 空值表示使用终端默认前景色，HTML 中使用合理的回退值
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

/**
 * 判断指定主题是否为浅色主题。
 * 当前仅通过主题名称判断，未来可扩展为分析颜色亮度。
 * 被 HTML 导出模块调用，用于生成适配浅色/深色的 CSS 变体。
 *
 * @param themeName - 可选的主题名称
 * @returns 是否为浅色主题
 */
export function isLightTheme(themeName?: string): boolean {
	// 目前仅检查名称 - 未来可扩展为分析颜色亮度
	return themeName === "light";
}

/**
 * 获取主题 JSON 中显式定义的导出颜色配置。
 * 返回 HTML 导出时的页面背景色、卡片背景色和信息区背景色。
 * 未显式设置的颜色返回 undefined。
 * 被 HTML 导出模块调用。
 *
 * @param themeName - 可选的主题名称，不指定时使用当前主题
 * @returns 包含 pageBg、cardBg、infoBg 的对象，未设置的为 undefined
 */
export function getThemeExportColors(themeName?: string): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	try {
		const themeJson = loadThemeJson(name);
		const exportSection = themeJson.export;
		if (!exportSection) return {};

		const vars = themeJson.vars ?? {};
		const resolve = (value: ColorValue | undefined): string | undefined => {
			if (value === undefined) return undefined;
			const resolved = resolveVarRefs(value, vars);
			if (typeof resolved === "number") return ansi256ToHex(resolved);
			if (resolved === "") return undefined;
			return resolved;
		};

		return {
			pageBg: resolve(exportSection.pageBg),
			cardBg: resolve(exportSection.cardBg),
			infoBg: resolve(exportSection.infoBg),
		};
	} catch {
		return {};
	}
}

// ============================================================================
// TUI 辅助函数
// ============================================================================

/** cli-highlight 库所需的语法高亮主题类型：语法标记名到着色函数的映射 */
type CliHighlightTheme = Record<string, (s: string) => string>;

/** 高亮主题缓存：缓存对应的 Theme 实例，主题不变时直接复用 */
let cachedHighlightThemeFor: Theme | undefined;
/** 高亮主题缓存：已构建的 CliHighlightTheme 对象 */
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

/**
 * 根据当前 Theme 实例构建 cli-highlight 库所需的语法高亮主题。
 * 将主题中的语法颜色令牌（syntaxKeyword、syntaxComment 等）映射到 cli-highlight 的语法标记类别。
 * 被 getCliHighlightTheme() 调用。
 *
 * @param t - 当前 Theme 实例
 * @returns cli-highlight 主题对象
 */
function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		string: (s: string) => t.fg("syntaxString", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
	};
}

/**
 * 获取 cli-highlight 语法高亮主题（带缓存）。
 * 如果 Theme 实例未变化，直接返回缓存的主题对象避免重复构建。
 * 被 highlightCode() 和 getMarkdownTheme() 的 highlightCode 调用。
 *
 * @param t - 当前 Theme 实例
 * @returns cli-highlight 主题对象
 */
function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

/**
 * 对代码进行语法高亮渲染。
 * 根据文件扩展名或语言标识符选择合适的语法高亮规则。
 * 被 Markdown 渲染组件和代码块展示组件调用。
 *
 * @param code - 待高亮的源代码文本
 * @param lang - 可选的语言标识符（如 "typescript"、"python"）
 * @returns 高亮后的代码行数组
 */
export function highlightCode(code: string, lang?: string): string[] {
	// 先验证语言是否受支持，避免 cli-highlight 输出无效语言的 stderr 警告
	const validLang = lang && supportsLanguage(lang) ? lang : undefined;
	// 未指定有效语言时跳过高亮。cli-highlight 的自动检测不可靠，
	// 可能将散文误识别为 AppleScript、LiveCodeServer 等，导致随机英文单词被着色为关键字。
	if (!validLang) {
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: getCliHighlightTheme(theme),
	};
	try {
		return highlight(code, opts).split("\n");
	} catch {
		return code.split("\n");
	}
}

/**
 * 根据文件路径的扩展名获取对应的编程语言标识符。
 * 支持约 50 种常见文件扩展名的映射。
 * 被 Markdown 渲染组件调用以确定代码块的语法高亮语言。
 *
 * @param filePath - 文件路径
 * @returns 语言标识符字符串（如 "typescript"），未匹配时返回 undefined
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

/**
 * 获取 Markdown 渲染主题配置。
 * 将主题中的 Markdown 颜色令牌映射到 pi-tui 的 MarkdownTheme 接口。
 * 包含标题、链接、代码块、引用、列表等元素的着色函数。
 * 被 Markdown 渲染组件（AssistantMessageComponent 等）调用。
 *
 * @returns MarkdownTheme 主题配置对象
 */
export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		highlightCode: (code: string, lang?: string): string[] => {
			// 先验证语言是否受支持，避免 cli-highlight 输出无效语言的 stderr 警告
			const validLang = lang && supportsLanguage(lang) ? lang : undefined;
			// 未指定有效语言时跳过高亮。cli-highlight 的自动检测不可靠，
			// 可能将散文误识别为 AppleScript、LiveCodeServer 等，导致随机英文单词被着色为关键字。
			if (!validLang) {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
			const opts = {
				language: validLang,
				ignoreIllegals: true,
				theme: getCliHighlightTheme(theme),
			};
			try {
				return highlight(code, opts).split("\n");
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
		},
	};
}

/**
 * 获取选择列表主题配置。
 * 将主题颜色令牌映射到 pi-tui 的 SelectListTheme 接口。
 * 被 getEditorTheme() 内部调用，也被独立的选择器组件使用。
 *
 * @returns SelectListTheme 主题配置对象
 */
export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

/**
 * 获取编辑器主题配置。
 * 将主题颜色令牌映射到 pi-tui 的 EditorTheme 接口。
 * 被 CustomEditorComponent 和 ExtensionEditorComponent 调用。
 *
 * @returns EditorTheme 主题配置对象
 */
export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}

/**
 * 获取设置列表主题配置。
 * 将主题颜色令牌映射到 pi-tui 的 SettingsListTheme 接口。
 * 被 SettingsSelectorComponent 调用。
 *
 * @returns SettingsListTheme 主题配置对象
 */
export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}
