/**
 * HTML 实体解码工具
 *
 * 解码 HTML 实体（如 &amp;、&#65;、&#x41;）为对应的 Unicode 字符。
 * 支持三类实体：
 * - 命名实体：amp、lt、gt、quot、apos
 * - 十六进制数字实体：&#xNN; 或 &#XNN;
 * - 十进制数字实体：&#NNN;
 *
 * 调用方：syntax-highlight.ts 的高亮 HTML 渲染调用。
 */

/** 解码后的 HTML 实体结果 */
export interface DecodedHtmlEntity {
	/** 解码后的文本内容 */
	text: string;
	/** 原始实体在 HTML 字符串中的长度（包含 & 和 ;） */
	length: number;
}

/**
 * 将 Unicode 码点转换为对应的字符。
 *
 * @param codePoint - Unicode 码点（0 到 0x10ffff）
 * @returns 对应的字符，无效码点返回 undefined
 */
function decodeCodePoint(codePoint: number): string | undefined {
	if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
		return undefined;
	}
	return String.fromCodePoint(codePoint);
}

/**
 * 解码单个 HTML 实体（不含 & 和 ; 包裹符）。
 *
 * @param entity - 实体内容（如 "amp"、"#65"、"#x41"）
 * @returns 解码后的字符，无法识别的实体返回 undefined
 */
export function decodeHtmlEntity(entity: string): string | undefined {
	// 命名实体查找
	switch (entity) {
		case "amp":
			return "&";
		case "lt":
			return "<";
		case "gt":
			return ">";
		case "quot":
			return '"';
		case "apos":
			return "'";
	}

	// 十六进制数字实体：&#xNN; 或 &#XNN;
	if (entity.startsWith("#x") || entity.startsWith("#X")) {
		return decodeCodePoint(Number.parseInt(entity.slice(2), 16));
	}

	// 十进制数字实体：&#NNN;
	if (entity.startsWith("#")) {
		return decodeCodePoint(Number.parseInt(entity.slice(1), 10));
	}

	return undefined;
}

/**
 * 解码 HTML 字符串中指定位置的 HTML 实体。
 *
 * 从 index 位置开始（应指向 '&' 字符），查找到 ';' 为止，
 * 提取并解码中间的实体内容。
 *
 * @param html - HTML 字符串
 * @param index - '&' 字符在字符串中的位置
 * @returns 解码结果（文本和原始长度），位置无有效实体时返回 undefined
 */
export function decodeHtmlEntityAt(html: string, index: number): DecodedHtmlEntity | undefined {
	// 查找实体结束标记 ';'，限制最大长度避免误匹配
	const semicolonIndex = html.indexOf(";", index + 1);
	if (semicolonIndex === -1 || semicolonIndex - index > 16) {
		return undefined;
	}

	const entity = html.slice(index + 1, semicolonIndex);
	const decoded = decodeHtmlEntity(entity);
	if (decoded === undefined) {
		return undefined;
	}

	return { text: decoded, length: semicolonIndex - index + 1 };
}
