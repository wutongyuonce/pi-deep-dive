/**
 * YAML frontmatter 解析工具
 *
 * 解析文件头部的 YAML frontmatter 元数据块（由 "---" 分隔）。
 * 用于解析 skill 文件、prompt 模板等的元数据配置。
 *
 * 支持的格式：
 * ---
 * key: value
 * list:
 *   - item
 * ---
 * 正文内容...
 *
 * 调用方：skills.ts（技能定义解析）、resource-loader.ts（资源加载）等。
 */

import { parse } from "yaml";

/** 解析后的 frontmatter 结果类型 */
type ParsedFrontmatter<T extends Record<string, unknown>> = {
	/** 解析后的 YAML 元数据对象 */
	frontmatter: T;
	/** frontmatter 之后的正文内容 */
	body: string;
};

/**
 * 统一换行符为 LF (\n)。
 *
 * @param value - 原始字符串
 * @returns 换行符统一后的字符串
 */
const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/**
 * 从内容中提取 YAML frontmatter 字符串和正文。
 *
 * 查找开头的 "---" 标记，提取到下一个 "\n---" 之间的 YAML 内容。
 *
 * @param content - 原始文件内容
 * @returns 包含 yamlString（YAML 字符串或 null）和 body（正文）的对象
 */
const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	const normalized = normalizeNewlines(content);

	// 不以 "---" 开头则无 frontmatter
	if (!normalized.startsWith("---")) {
		return { yamlString: null, body: normalized };
	}

	// 查找结束标记 "\n---"
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		// 未找到结束标记，视为无 frontmatter
		return { yamlString: null, body: normalized };
	}

	return {
		yamlString: normalized.slice(4, endIndex),
		body: normalized.slice(endIndex + 4).trim(),
	};
};

/**
 * 解析字符串中的 YAML frontmatter。
 *
 * 将 "---" 包裹的 YAML 元数据解析为类型化的对象，
 * 同时返回去除 frontmatter 后的正文内容。
 *
 * @param content - 包含可能的 frontmatter 的原始字符串
 * @returns 包含 frontmatter 对象和 body 字符串的结果
 */
export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yamlString, body } = extractFrontmatter(content);
	if (!yamlString) {
		return { frontmatter: {} as T, body };
	}
	const parsed = parse(yamlString);
	return { frontmatter: (parsed ?? {}) as T, body };
};

/**
 * 移除字符串中的 YAML frontmatter，仅返回正文内容。
 *
 * @param content - 包含可能的 frontmatter 的原始字符串
 * @returns 去除 frontmatter 后的正文内容
 */
export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
