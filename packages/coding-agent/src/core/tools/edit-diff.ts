/**
 * 编辑 diff 工具 (edit-diff.ts)
 *
 * 本文件提供编辑操作的 diff 计算工具函数，被 edit.ts（执行）和 TUI 预览渲染共同使用。
 *
 * 定位：
 *   edit.ts 的核心依赖，负责文件内容的精确文本替换、模糊匹配和 diff 生成。
 *
 * 提供的能力：
 *   1. 行尾处理：detectLineEnding、normalizeToLF、restoreLineEndings
 *   2. 模糊匹配：normalizeForFuzzyMatch（Unicode 规范化）、fuzzyFindText（精确→模糊回退）
 *   3. 编辑应用：applyEditsToNormalizedContent（批量精确替换，反序应用保持偏移稳定）
 *   4. Diff 生成：generateUnifiedPatch（标准 unified patch）、generateDiffString（带行号的显示 diff）
 *   5. 预览计算：computeEditsDiff / computeEditDiff（不实际写入文件的 diff 预览）
 *
 * 调用链路：
 *   edit.ts execute → stripBom → normalizeToLF → applyEditsToNormalizedContent → writeFile
 *   edit.ts renderCall → computeEditsDiff → 读取文件 + applyEditsToNormalizedContent + generateDiffString
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.ts";

/**
 * 检测文本的行尾格式。
 * @returns "\r\n"（Windows）或 "\n"（Unix）
 */
export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/**
 * 将文本中的所有行尾统一为 LF (\n)。
 * 被 edit.ts 和 computeEditsDiff 调用，在编辑匹配前统一格式。
 */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * 将 LF 行尾恢复为原始行尾格式。
 * 被 edit.ts 在应用编辑后恢复原始文件的行尾风格。
 */
export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * 规范化文本用于模糊匹配。应用渐进式转换：
 *   1. NFKC Unicode 规范化
 *   2. 去除每行末尾的空白
 *   3. 智能引号 → ASCII 等价物
 *   4. Unicode 破折号/连字符 → ASCII 连字符
 *   5. 特殊 Unicode 空格 → 普通空格
 *
 * 被 fuzzyFindText 和 applyEditsToNormalizedContent 调用。
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// 去除每行末尾的空白
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// 智能单引号 → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// 智能双引号 → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// 各种破折号/连字符 → -
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// 特殊 Unicode 空格 → 普通空格
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/** 模糊匹配结果 */
export interface FuzzyMatchResult {
	/** 是否找到匹配 */
	found: boolean;
	/** 匹配起始位置索引（在用于替换操作的内容中） */
	index: number;
	/** 匹配文本的长度 */
	matchLength: number;
	/** 是否使用了模糊匹配（false = 精确匹配） */
	usedFuzzyMatch: boolean;
	/**
	 * 用于替换操作的内容。
	 * 精确匹配时为原始内容，模糊匹配时为规范化后的内容。
	 */
	contentForReplacement: string;
}

/** 单个编辑操作：旧文本 → 新文本 */
export interface Edit {
	oldText: string;
	newText: string;
}

/** 已匹配的编辑操作，包含匹配位置信息（内部使用） */
interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

/** 编辑应用结果 */
export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * 在内容中查找 oldText，先尝试精确匹配，再回退到模糊匹配。
 *
 * 模糊匹配时，返回的 contentForReplacement 是规范化后的内容
 * （去除了行尾空白、Unicode 引号/破折号标准化为 ASCII）。
 *
 * 被 applyEditsToNormalizedContent 内部调用。
 *
 * @param content  要搜索的内容
 * @param oldText  要查找的文本
 * @returns 匹配结果（是否找到、位置、长度、是否模糊匹配、替换用内容）
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// 先尝试精确匹配
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// 回退到模糊匹配 — 完全在规范化空间中工作
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// 模糊匹配时，在规范化空间中进行替换。
	// 输出中会使用规范化的空白/引号/破折号，这是可接受的，
	// 因为模糊匹配本身就是在修复微小的格式差异。
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

/**
 * 剥离 UTF-8 BOM（如果存在），返回 BOM 和去 BOM 后的文本。
 * 被 edit.ts 和 computeEditsDiff 调用，因为 LLM 不会在 oldText 中包含不可见的 BOM。
 */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** 计算 oldText 在内容中的出现次数（模糊规范化后计数），用于检测重复匹配 */
function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

/** 生成 "找不到文本" 的错误信息，区分单编辑和多编辑场景 */
function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

/** 生成 "文本不唯一" 的错误信息 */
function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

/** 生成 "oldText 为空" 的错误信息 */
function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

/** 生成 "替换后内容未变化" 的错误信息 */
function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * 对已标准化（LF 行尾）的内容应用一个或多个精确文本替换。
 *
 * 工作流程：
 *   1. 将所有编辑的 oldText/newText 标准化为 LF
 *   2. 对每个编辑执行 fuzzyFindText 定位
 *   3. 验证：oldText 不为空、找到匹配、匹配唯一、编辑不重叠
 *   4. 按匹配位置排序后反序应用替换（保持偏移稳定）
 *   5. 如果任何编辑需要模糊匹配，在模糊规范化的内容空间中执行
 *
 * 被 edit.ts execute 和 computeEditsDiff 调用。
 *
 * @param normalizedContent  已标准化为 LF 行尾的文件内容
 * @param edits              编辑操作数组
 * @param path               文件路径（用于错误信息）
 * @returns 基础内容和新内容
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
		? normalizeForFuzzyMatch(normalizedContent)
		: normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(baseContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = countOccurrences(baseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/**
 * 生成标准 unified patch 格式。
 * 被 edit.ts execute 在返回结果详情时调用。
 */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * 生成面向显示的 diff 字符串，包含行号和上下文。
 * 用于 TUI 中的编辑结果渲染和预览。
 *
 * @returns diff 字符串和新文件中第一个变更行的行号
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
				// 记录第一个变更行（在新文件中的位置）
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// 显示变更
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// 上下文行 — 只在变更前后显示若干行
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// 完全跳过这些上下文行
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

/** 编辑 diff 预览结果 */
export interface EditDiffResult {
	/** diff 字符串 */
	diff: string;
	/** 新文件中第一个变更行的行号 */
	firstChangedLine: number | undefined;
}

/** 编辑 diff 预览错误 */
export interface EditDiffError {
	/** 错误信息 */
	error: string;
}

/**
 * 计算一个或多个编辑操作的 diff，不实际应用。
 * 在 TUI 中工具执行前用于预览渲染。
 * 被 edit.ts 的 renderCall 方法调用。
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// 检查文件是否存在且可读
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// 读取文件
		const rawContent = await readFile(absolutePath, "utf-8");

		// 匹配前剥离 BOM（LLM 不会在 oldText 中包含不可见的 BOM）
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// 生成 diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 计算单个编辑操作的 diff，不实际应用。
 * 作为 computeEditsDiff 的便捷包装，适用于单编辑调用场景。
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
