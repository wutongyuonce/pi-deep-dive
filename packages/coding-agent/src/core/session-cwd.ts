/**
 * 会话工作目录校验模块
 *
 * 检测恢复会话时，会话文件中记录的工作目录（cwd）是否仍然存在。
 * 当用户在不同目录间切换时，会话的 cwd 可能已被删除或移动，
 * 此模块负责检测该问题并提供用户友好的错误/提示消息。
 */

import { existsSync } from "node:fs";

/**
 * 会话工作目录缺失问题描述
 */
export interface SessionCwdIssue {
	/** 相关的会话文件路径 */
	sessionFile?: string;
	/** 会话中记录的工作目录 */
	sessionCwd: string;
	/** 回退到的当前工作目录 */
	fallbackCwd: string;
}

/** 会话管理器的 cwd 来源接口（最小依赖） */
interface SessionCwdSource {
	getCwd(): string;
	getSessionFile(): string | undefined;
}

/**
 * 检查会话工作目录是否缺失
 * @param sessionManager 会话管理器实例
 * @param fallbackCwd 当前实际的工作目录（回退值）
 * @returns 如果会话 cwd 不存在则返回问题描述，否则返回 undefined
 */
export function getMissingSessionCwdIssue(
	sessionManager: SessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionCwd = sessionManager.getCwd();
	if (!sessionCwd || existsSync(sessionCwd)) {
		return undefined;
	}

	return {
		sessionFile,
		sessionCwd,
		fallbackCwd,
	};
}

/**
 * 格式化会话 cwd 缺失的错误消息
 * @param issue 问题描述
 * @returns 包含会话文件路径和 cwd 信息的错误字符串
 */
export function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
	const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
	return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}\nCurrent working directory: ${issue.fallbackCwd}`;
}

/**
 * 格式化会话 cwd 缺失的用户提示消息
 * @param issue 问题描述
 * @returns 用于 TUI 展示的简洁提示
 */
export function formatMissingSessionCwdPrompt(issue: SessionCwdIssue): string {
	return `cwd from session file does not exist\n${issue.sessionCwd}\n\ncontinue in current cwd\n${issue.fallbackCwd}`;
}

/**
 * 会话工作目录缺失错误
 * 当断言失败时抛出，携带完整的问题上下文信息。
 */
export class MissingSessionCwdError extends Error {
	readonly issue: SessionCwdIssue;

	constructor(issue: SessionCwdIssue) {
		super(formatMissingSessionCwdError(issue));
		this.name = "MissingSessionCwdError";
		this.issue = issue;
	}
}

/**
 * 断言会话工作目录存在
 * @param sessionManager 会话管理器实例
 * @param fallbackCwd 当前实际的工作目录
 * @throws {MissingSessionCwdError} 如果会话 cwd 不存在
 */
export function assertSessionCwdExists(sessionManager: SessionCwdSource, fallbackCwd: string): void {
	const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
	if (issue) {
		throw new MissingSessionCwdError(issue);
	}
}
