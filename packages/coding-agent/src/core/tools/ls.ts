/**
 * 目录列表工具 (ls.ts)
 *
 * 本文件实现了目录列表工具，允许 Agent 查看目录中的文件和子目录。
 *
 * 提供的能力：
 *   - 列出目录内容，按字母顺序排列（大小写不敏感）
 *   - 目录以 "/" 后缀标识，包含隐藏文件
 *   - 输出截断：条目数限制（默认 500）+ 字节限制（默认 50KB）
 *   - TUI 渲染：折叠/展开模式显示目录列表
 *
 * 调用链路：index.ts createLsTool → createLsToolDefinition → wrapToolDefinition
 * 依赖模块：
 *   - path-utils.ts：路径解析（resolveToCwd、pathExists）
 *   - truncate.ts：头部截断（truncateHead）
 *   - render-utils.ts：文本渲染辅助
 *   - tool-definition-wrapper.ts：ToolDef → AgentTool 包装
 */

import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import nodePath from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

/** ls 工具的输入参数 schema：可选的目录路径和条目数限制 */
const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

/** ls 工具执行结果的附加详情 */
export interface LsToolDetails {
	/** 截断信息（字节限制触发时） */
	truncation?: TruncationResult;
	/** 条目数限制被触发时的限制值 */
	entryLimitReached?: number;
}

/**
 * ls 工具的可插拔操作接口。
 * 覆盖这些方法可将目录列表委托到远程系统（如 SSH）。
 */
export interface LsOperations {
	/** 检查路径是否存在 */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** 获取文件或目录的统计信息（不存在时抛出异常） */
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	/** 读取目录条目列表 */
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

/** 默认的本地文件系统目录列表操作 */
const defaultLsOperations: LsOperations = {
	exists: pathExists,
	stat: fsStat,
	readdir: fsReaddir,
};

/** ls 工具的配置选项 */
export interface LsToolOptions {
	/** 自定义目录列表操作，默认使用本地文件系统 */
	operations?: LsOperations;
}

/** 格式化 ls 工具调用的显示文本 */
function formatLsCall(
	args: { path?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${path === null ? invalidArg : theme.fg("accent", path)}`;
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

/** 格式化 ls 工具结果的显示文本 */
function formatLsResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: LsToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const entryLimit = result.details?.entryLimitReached;
	const truncation = result.details?.truncation;
	if (entryLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (entryLimit) warnings.push(`${entryLimit} entries limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

/** 创建 ls 工具定义 */
export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	const ops = options?.operations ?? defaultLsOperations;
	return {
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "List directory contents",
		parameters: lsSchema,
		async execute(
			_toolCallId,
			{ path, limit }: { path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const dirPath = resolveToCwd(path || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;

						// 检查路径是否存在
						if (!(await ops.exists(dirPath))) {
							reject(new Error(`Path not found: ${dirPath}`));
							return;
						}

						// 检查路径是否为目录
						const stat = await ops.stat(dirPath);
						if (!stat.isDirectory()) {
							reject(new Error(`Not a directory: ${dirPath}`));
							return;
						}

						// 读取目录条目
						let entries: string[];
						try {
							entries = await ops.readdir(dirPath);
						} catch (e: any) {
							reject(new Error(`Cannot read directory: ${e.message}`));
							return;
						}

						// 按字母顺序排序（大小写不敏感）
						entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

						// 格式化条目，为目录添加 "/" 后缀标识
						const results: string[] = [];
						let entryLimitReached = false;
						for (const entry of entries) {
							if (results.length >= effectiveLimit) {
								entryLimitReached = true;
								break;
							}

							const fullPath = nodePath.join(dirPath, entry);
							let suffix = "";
							try {
								const entryStat = await ops.stat(fullPath);
								if (entryStat.isDirectory()) suffix = "/";
							} catch {
								// 跳过无法获取统计信息的条目
								continue;
							}
							results.push(entry + suffix);
						}

						signal?.removeEventListener("abort", onAbort);

						if (results.length === 0) {
							resolve({ content: [{ type: "text", text: "(empty directory)" }], details: undefined });
							return;
						}

						const rawOutput = results.join("\n");
						// 应用字节截断。此处不设行数限制，因为条目数已经限制了行数
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
						let output = truncation.content;
						const details: LsToolDetails = {};
						// 构建截断和条目限制的可操作提示
						const notices: string[] = [];
						if (entryLimitReached) {
							notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
							details.entryLimitReached = effectiveLimit;
						}
						if (truncation.truncated) {
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							details.truncation = truncation;
						}
						if (notices.length > 0) {
							output += `\n\n[${notices.join(". ")}]`;
						}

						resolve({
							content: [{ type: "text", text: output }],
							details: Object.keys(details).length > 0 ? details : undefined,
						});
					} catch (e: any) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatLsCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatLsResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

/** 创建 ls 工具实例，通过 wrapToolDefinition 将 ToolDef 包装为 AgentTool */
export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
