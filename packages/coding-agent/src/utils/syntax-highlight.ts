/**
 * 代码语法高亮工具
 *
 * 使用 highlight.js 进行语言检测和代码高亮，将 HTML span 标签
 * 渲染为终端 ANSI 样式（通过自定义主题映射）。
 * 被 TUI 代码块渲染功能调用。
 */
import hljs from "highlight.js/lib/index.js";
import { decodeHtmlEntityAt } from "./html.ts";

/** 高亮格式化函数：接收纯文本，返回带样式的文本 */
export type HighlightFormatter = (text: string) => string;
/** 高亮主题：作用域名到格式化函数的映射 */
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

/** 语法高亮选项 */
export interface HighlightOptions {
	language?: string; // 指定语言（省略则自动检测）
	ignoreIllegals?: boolean; // 忽略非法语法错误
	languageSubset?: string[]; // 自动检测时的候选语言子集
	theme?: HighlightTheme; // 自定义高亮主题
}

/** HTML span 关闭标签 */
const SPAN_CLOSE = "</span>";
/** highlight.js 的 CSS 类名前缀 */
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

/**
 * 从 span 开标签中提取 highlight.js 的作用域名
 * @param tag - 完整的 span 开标签字符串
 * @returns 作用域名（如 "keyword"、"string"），未找到返回 undefined
 */
function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	// 从 CSS 类名中查找 hljs- 前缀的作用域类
	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

/**
 * 根据作用域名查找主题中的格式化函数
 * 支持精确匹配、点号前缀匹配和连字符前缀匹配
 * @param scope - 作用域名
 * @param theme - 高亮主题
 * @returns 匹配的格式化函数，未找到返回 undefined
 */
function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	// 精确匹配
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	// 点号前缀匹配（如 "keyword.declaration" → "keyword"）
	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	// 连字符前缀匹配（如 "builtin-name" → "builtin"）
	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

/**
 * 获取当前活跃的格式化函数
 * 从嵌套作用域栈的栈顶向下查找，返回最近匹配的格式化函数
 * @param scopes - 当前嵌套的作用域栈
 * @param theme - 高亮主题
 * @returns 格式化函数，未找到则返回 theme.default
 */
function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	// 从栈顶（最内层作用域）开始查找
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

/**
 * 检查 HTML 字符串在指定位置是否为 span 开标签的起始
 */
function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	// 标签名后必须是 >、空格、tab 或换行（避免匹配如 <spanner> 等标签）
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

/**
 * 将 highlight.js 生成的 HTML 渲染为带样式的终端文本
 * 逐字符解析 HTML，维护作用域栈，对文本内容应用主题格式化
 *
 * @param html - highlight.js 输出的 HTML 字符串
 * @param theme - 高亮主题（作用域名 → 格式化函数）
 * @returns 渲染后的终端文本
 */
export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	let textBuffer = "";
	// 作用域栈，跟踪嵌套的 span 标签作用域
	const scopes: Array<string | undefined> = [];

	// 将缓冲区中的文本应用当前作用域的格式化函数后输出
	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter ? formatter(textBuffer) : textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		// 遇到 span 开标签：提取作用域并压栈
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				scopes.push(scope);
				index = tagEndIndex + 1;
				continue;
			}
		}

		// 遇到 span 关闭标签：刷新文本并弹出作用域
		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		// 遇到 HTML 实体：解码后追加到文本缓冲区
		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		// 普通字符：追加到文本缓冲区
		textBuffer += html[index];
		index++;
	}

	// 刷新剩余的文本缓冲区
	flushText();
	return output;
}

/**
 * 对代码进行语法高亮
 * @param code - 源代码字符串
 * @param options - 高亮选项（语言、主题等）
 * @returns 带样式的终端文本
 */
export function highlight(code: string, options: HighlightOptions = {}): string {
	// 指定语言时使用精确高亮，否则使用自动检测
	const html = options.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	return renderHighlightedHtml(html, options.theme);
}

/**
 * 检查 highlight.js 是否支持指定的编程语言
 * @param name - 语言名称（如 "typescript"、"python"）
 * @returns true 表示支持该语言
 */
export function supportsLanguage(name: string): boolean {
	return hljs.getLanguage(name) !== undefined;
}
