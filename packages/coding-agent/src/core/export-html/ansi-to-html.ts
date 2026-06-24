/**
 * ANSI 转义码转 HTML 转换器。
 *
 * 将终端 ANSI 颜色/样式码转换为带内联样式的 HTML。
 * 支持：
 * - 标准前景色（30-37）和高亮变体（90-97）
 * - 标准背景色（40-47）和高亮变体（100-107）
 * - 256 色调色板（38;5;N 和 48;5;N）
 * - RGB 真彩色（38;2;R;G;B 和 48;2;R;G;B）
 * - 文本样式：粗体（1）、暗淡（2）、斜体（3）、下划线（4）
 * - 重置（0）
 */

// 标准 ANSI 调色板（0-15）
const ANSI_COLORS = [
	"#000000", // 0: black
	"#800000", // 1: red
	"#008000", // 2: green
	"#808000", // 3: yellow
	"#000080", // 4: blue
	"#800080", // 5: magenta
	"#008080", // 6: cyan
	"#c0c0c0", // 7: white
	"#808080", // 8: bright black
	"#ff0000", // 9: bright red
	"#00ff00", // 10: bright green
	"#ffff00", // 11: bright yellow
	"#0000ff", // 12: bright blue
	"#ff00ff", // 13: bright magenta
	"#00ffff", // 14: bright cyan
	"#ffffff", // 15: bright white
];

/**
 * 将 256 色索引转换为十六进制。
 * 处理 3 个范围：标准色（0-15）、色立方体（16-231）、灰度（232-255）。
 *
 * 被谁调用：applySgrCode()
 */
function color256ToHex(index: number): string {
	// 标准色（0-15）
	if (index < 16) {
		return ANSI_COLORS[index];
	}

	// 色立方体（16-231）：6x6x6 = 216 色
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toComponent = (n: number) => (n === 0 ? 0 : 55 + n * 40);
		const toHex = (n: number) => toComponent(n).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// 灰度（232-255）：24 级
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * 转义 HTML 特殊字符（&、<、>、"、'）。
 *
 * 被谁调用：ansiToHtml()
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

interface TextStyle {
	fg: string | null;
	bg: string | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
}

function createEmptyStyle(): TextStyle {
	return {
		fg: null,
		bg: null,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
	};
}

function styleToInlineCSS(style: TextStyle): string {
	const parts: string[] = [];
	if (style.fg) parts.push(`color:${style.fg}`);
	if (style.bg) parts.push(`background-color:${style.bg}`);
	if (style.bold) parts.push("font-weight:bold");
	if (style.dim) parts.push("opacity:0.6");
	if (style.italic) parts.push("font-style:italic");
	if (style.underline) parts.push("text-decoration:underline");
	return parts.join(";");
}

function hasStyle(style: TextStyle): boolean {
	return style.fg !== null || style.bg !== null || style.bold || style.dim || style.italic || style.underline;
}

/**
 * 解析 ANSI SGR（选择图形再现）码并更新样式。
 * 支持：标准前景/背景色、高亮变体、256 色调色板、RGB 真彩色、文本样式。
 *
 * 被谁调用：ansiToHtml()
 */
function applySgrCode(params: number[], style: TextStyle): void {
	let i = 0;
	while (i < params.length) {
		const code = params[i];

		if (code === 0) {
			// 重置所有样式
			style.fg = null;
			style.bg = null;
			style.bold = false;
			style.dim = false;
			style.italic = false;
			style.underline = false;
		} else if (code === 1) {
			style.bold = true;
		} else if (code === 2) {
			style.dim = true;
		} else if (code === 3) {
			style.italic = true;
		} else if (code === 4) {
			style.underline = true;
		} else if (code === 22) {
			// 重置粗体/暗淡
			style.bold = false;
			style.dim = false;
		} else if (code === 23) {
			style.italic = false;
		} else if (code === 24) {
			style.underline = false;
		} else if (code >= 30 && code <= 37) {
			// 标准前景色
			style.fg = ANSI_COLORS[code - 30];
		} else if (code === 38) {
			// 扩展前景色
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256 色：38;5;N
				style.fg = color256ToHex(params[i + 2]);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB：38;2;R;G;B
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.fg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 39) {
			// 默认前景色
			style.fg = null;
		} else if (code >= 40 && code <= 47) {
			// 标准背景色
			style.bg = ANSI_COLORS[code - 40];
		} else if (code === 48) {
			// 扩展背景色
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256 色：48;5;N
				style.bg = color256ToHex(params[i + 2]);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB：48;2;R;G;B
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.bg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 49) {
			// 默认背景色
			style.bg = null;
		} else if (code >= 90 && code <= 97) {
			// 高亮前景色
			style.fg = ANSI_COLORS[code - 90 + 8];
		} else if (code >= 100 && code <= 107) {
			// 高亮背景色
			style.bg = ANSI_COLORS[code - 100 + 8];
		}
		// 忽略无法识别的码

		i++;
	}
}

// 匹配 ANSI 转义序列：ESC[ 后跟参数并以 'm' 结尾
const ANSI_REGEX = /\x1b\[([\d;]*)m/g;

/**
 * 将带 ANSI 转义的文本转换为带内联样式的 HTML。
 *
 * 实现逻辑：
 * 1. 使用正则匹配 ANSI 转义序列（\x1b[N...m）
 * 2. 对每个匹配：关闭前一个 span → 应用 SGR 码更新样式 → 打开新 span
 * 3. 转义文本中的 HTML 特殊字符
 * 4. 处理完毕后关闭所有打开的 span
 *
 * 被谁调用：ansiLinesToHtml()、tool-renderer.ts
 */
export function ansiToHtml(text: string): string {
	const style = createEmptyStyle();
	let result = "";
	let lastIndex = 0;
	let inSpan = false;

	// 重置正则状态
	ANSI_REGEX.lastIndex = 0;

	let match = ANSI_REGEX.exec(text);
	while (match !== null) {
		// 添加此转义序列之前的文本
		const beforeText = text.slice(lastIndex, match.index);
		if (beforeText) {
			result += escapeHtml(beforeText);
		}

		// 解析 SGR 参数
		const paramStr = match[1];
		const params = paramStr ? paramStr.split(";").map((p) => parseInt(p, 10) || 0) : [0];

		// 如果已有 span 则关闭
		if (inSpan) {
			result += "</span>";
			inSpan = false;
		}

		// Apply the codes
		applySgrCode(params, style);

		// Open new span if we have any styling
		if (hasStyle(style)) {
			result += `<span style="${styleToInlineCSS(style)}">`;
			inSpan = true;
		}

		lastIndex = match.index + match[0].length;
		match = ANSI_REGEX.exec(text);
	}

	// Add remaining text
	const remainingText = text.slice(lastIndex);
	if (remainingText) {
		result += escapeHtml(remainingText);
	}

	// Close any open span
	if (inSpan) {
		result += "</span>";
	}

	return result;
}

/**
 * 将 ANSI 转义的行数组转换为 HTML。
 * 每行包裹在 <div class="ansi-line"> 中，空行替换为 &nbsp; 以保留高度。
 *
 * 被谁调用：tool-renderer.ts 的 createToolHtmlRenderer()
 */
export function ansiLinesToHtml(lines: string[]): string {
	return lines.map((line) => `<div class="ansi-line">${ansiToHtml(line) || "&nbsp;"}</div>`).join("");
}
