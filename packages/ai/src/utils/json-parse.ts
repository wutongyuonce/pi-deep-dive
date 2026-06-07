/**
 * JSON 解析工具模块，专注于流式和容错场景。
 *
 * 文件定位：
 * - 提供对不完整、格式损坏的 JSON 字符串的解析能力
 * - 核心场景：LLM 流式返回工具调用参数时，JSON 是逐 chunk 到达的，需要增量解析
 * - 也处理包含裸控制字符或非法转义序列的 JSON（某些 LLM 经常产生这类输出）
 *
 * 谁调用我：
 * - providers/openai-completions.ts：导入 parseStreamingJson，用于流式解析工具调用参数
 * - providers/anthropic.ts：导入 parseStreamingJson 和 parseJsonWithRepair，
 *   前者用于流式解析，后者用于解析完整但可能有格式问题的 JSON
 * - providers/openai-responses-shared.ts：导入 parseStreamingJson，用于流式解析工具调用参数
 * - index.ts：通过桶导出向外部包暴露所有函数
 *
 * 调用链路：
 *   provider 流式处理循环
 *     -> parseStreamingJson(partialJson)           增量解析入口
 *       -> parseJsonWithRepair(partialJson)        先尝试标准解析 + 修复
 *         -> JSON.parse()                          标准解析
 *         -> repairJson()                          修复格式问题后重试
 *       -> partialParse(partialJson)               使用 partial-json 库解析不完整 JSON
 *       -> partialParse(repairJson(partialJson))   修复 + partial-parse 组合
 */

import { parse as partialParse } from "partial-json";

/** 合法的 JSON 转义字符集合（JSON 规范定义的 9 个转义序列）。 */
const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/**
 * 判断字符是否为 Unicode 控制字符（U+0000 到 U+001F）。
 * JSON 规范要求这些字符必须被转义（如 \n、\t）或使用 \uXXXX 形式。
 * 某些 LLM 会在 JSON 字符串中直接输出裸控制字符，导致 JSON.parse 报错。
 *
 * 谁调用我：repairJson() 的字符处理循环
 */
function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

/**
 * 将控制字符转为 JSON 合法的转义序列。
 *
 * 谁调用我：repairJson()（当检测到裸控制字符时）
 *
 * 映射规则：
 * - \b、\f、\n、\r、\t：使用对应的短转义序列
 * - 其他控制字符：使用 \uXXXX 形式（4 位十六进制 Unicode 码点）
 */
function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * 修复格式损坏的 JSON 字符串。
 *
 * 谁调用我：
 * - parseJsonWithRepair()（标准 JSON.parse 失败时调用修复后重试）
 * - parseStreamingJson()（作为 partial-parse 的预处理步骤）
 *
 * 我调用谁：
 * - isControlCharacter()（检测裸控制字符）
 * - escapeControlCharacter()（转义裸控制字符）
 *
 * 修复内容：
 * 1. 字符串内的裸控制字符：转为 \n、\t、\uXXXX 等合法转义
 * 2. 非法反斜杠转义：将 \x（x 不是合法转义字符）转为 \\x（双反斜杠）
 *
 * 算法：逐字符状态机，跟踪是否在字符串内部（inString），
 * 只对字符串内部的内容做修复，不影响 JSON 结构字符。
 */
export function repairJson(json: string): string {
	let repaired = "";
	// 状态标志：当前是否在 JSON 字符串内部
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			// 不在字符串内：直接输出，遇到引号则切换状态
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		// 在字符串内遇到引号：字符串结束
		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			// 遇到反斜杠：检查下一个字符是否为合法转义
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				// 字符串末尾的孤立反斜杠：转义为 \\
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				// Unicode 转义序列：检查后续 4 位是否为合法十六进制
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				// 合法的转义序列（如 \"、\\、\n 等）：原样保留
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			// 非法转义序列（如 \a、\z 等）：将反斜杠本身转义为 \\
			repaired += "\\\\";
			continue;
		}

		// 普通字符：控制字符需要转义，其他直接输出
		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

/**
 * 尝试解析 JSON，如果标准解析失败则先修复格式后重试。
 *
 * 谁调用我：
 * - providers/anthropic.ts：解析完整的工具调用参数 JSON
 * - parseStreamingJson()：作为第一次解析尝试
 *
 * 我调用谁：
 * - JSON.parse()（标准解析）
 * - repairJson()（格式修复）
 *
 * 策略：
 * 1. 先尝试 JSON.parse（最快路径，大部分情况会成功）
 * 2. 失败后调用 repairJson 修复格式
 * 3. 如果修复后内容不同（确实有修复），再次尝试 JSON.parse
 * 4. 如果修复后内容相同或再次失败，抛出原始错误
 */
export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * 尝试解析流式到达的不完整 JSON。
 * 即使 JSON 不完整也会返回一个尽可能完整的对象（不会抛错）。
 *
 * 谁调用我：
 * - providers/openai-completions.ts：流式解析工具调用参数（finishBlock 和 toolcall_delta 处理）
 * - providers/anthropic.ts：流式解析工具调用参数
 * - providers/openai-responses-shared.ts：流式解析工具调用参数
 *
 * 我调用谁：
 * - parseJsonWithRepair()：先尝试标准解析 + 修复
 * - partialParse()（来自 partial-json 库）：解析不完整 JSON 的专用库
 * - repairJson()：修复格式后再用 partial-parse 解析
 *
 * 四层降级策略（每层失败后尝试下一层）：
 * 1. parseJsonWithRepair：标准解析 + 修复（处理完整但有格式问题的 JSON）
 * 2. partialParse：解析不完整 JSON（如 {"key": "val" 还没收到闭合括号）
 * 3. partialParse(repairJson())：修复 + partial-parse 组合（不完整且有格式问题）
 * 4. 返回空对象 {}（兜底，永远不抛错）
 *
 * @param partialJson 流式到达的 JSON 片段（可能不完整或有格式问题）
 * @returns 解析后的对象，解析失败时返回空对象
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	// 空字符串或 undefined：直接返回空对象
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		// 第 1 层：标准解析 + 修复（最快路径，处理完整 JSON）
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			// 第 2 层：partial-parse 解析不完整 JSON
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				// 第 3 层：先修复格式再 partial-parse
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				// 第 4 层：兜底返回空对象
				return {} as T;
			}
		}
	}
}
