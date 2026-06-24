/**
 * CHANGELOG.md 解析工具
 *
 * 提供版本变更日志的解析、版本比较和新条目筛选能力。
 * 用于版本检查和更新通知流程，判断当前版本之后是否有新的变更发布。
 *
 * 调用方：版本检查模块、更新通知模块。
 */

import { existsSync, readFileSync } from "fs";

/**
 * 变更日志条目接口
 */
export interface ChangelogEntry {
	/** 主版本号 */
	major: number;
	/** 次版本号 */
	minor: number;
	/** 补丁版本号 */
	patch: number;
	/** 该版本的变更内容文本 */
	content: string;
}

/**
 * 解析 CHANGELOG.md 文件中的版本条目。
 *
 * 扫描以 "## " 开头的行作为版本标题，收集该版本下的所有内容，
 * 直到遇到下一个 "## " 标题或文件末尾。
 *
 * @param changelogPath - CHANGELOG.md 文件的路径
 * @returns 解析出的版本条目数组，文件不存在或解析失败时返回空数组
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: { major: number; minor: number; patch: number } | null = null;

		for (const line of lines) {
			// 检查是否为版本标题行（## [x.y.z] ...）
			if (line.startsWith("## ")) {
				// 保存上一个版本条目（如果存在）
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				// 尝试从标题行解析版本号
				const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
				if (versionMatch) {
					currentVersion = {
						major: Number.parseInt(versionMatch[1], 10),
						minor: Number.parseInt(versionMatch[2], 10),
						patch: Number.parseInt(versionMatch[3], 10),
					};
					currentLines = [line];
				} else {
					// 无法解析版本号时重置状态
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// 收集当前版本的内容行
				currentLines.push(line);
			}
		}

		// 保存最后一个版本条目
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * 比较两个版本号的大小。
 *
 * 依次比较主版本号、次版本号、补丁版本号。
 *
 * @param v1 - 第一个版本条目
 * @param v2 - 第二个版本条目
 * @returns v1 < v2 时返回负数，v1 === v2 时返回 0，v1 > v2 时返回正数
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * 获取比指定版本更新的所有变更条目。
 *
 * @param entries - 所有变更日志条目
 * @param lastVersion - 上次已知的版本号字符串（如 "1.2.3"）
 * @returns 比 lastVersion 更新的条目数组
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	// 解析版本号字符串为各部分
	const parts = lastVersion.split(".").map(Number);
	const last: ChangelogEntry = {
		major: parts[0] || 0,
		minor: parts[1] || 0,
		patch: parts[2] || 0,
		content: "",
	};

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

// 从 config.ts 重新导出 getChangelogPath，方便调用方使用
export { getChangelogPath } from "../config.ts";
