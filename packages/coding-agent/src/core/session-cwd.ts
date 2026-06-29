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
 * 定位：恢复会话前的 cwd 健康检查入口。
 * 作用：比对会话记录目录和当前回退目录，发现“会话目录已丢失”的异常状态。
 * 调用关系：由会话恢复流程调用；若返回问题对象，后续可转为提示文案或异常。
 *
 * @param sessionManager 会话管理器实例
 * @param fallbackCwd 当前实际的工作目录（回退值）
 * @returns 如果会话 cwd 不存在则返回问题描述，否则返回 undefined
 */
export function getMissingSessionCwdIssue(
	sessionManager: SessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	const sessionFile = sessionManager.getSessionFile();
	// 没有会话文件说明当前不是从持久化会话恢复，直接跳过检查。
	if (!sessionFile) {
		return undefined;
	}

	const sessionCwd = sessionManager.getCwd();
	// 记录的 cwd 为空或仍然存在时，无需向上游报告问题。
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
 * 定位：cwd 缺失问题的错误文案构造器。
 * 作用：把结构化问题对象转成适合异常抛出的完整诊断字符串。
 * 调用关系：由 `MissingSessionCwdError` 构造函数调用，也可供其他错误分支复用。
 *
 * @param issue 问题描述
 * @returns 包含会话文件路径和 cwd 信息的错误字符串
 */
export function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
	// 仅在会话文件已知时补充路径行，保持错误文案紧凑。
	const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
	return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}\nCurrent working directory: ${issue.fallbackCwd}`;
}

/**
 * 定位：cwd 缺失问题的交互提示文案构造器。
 * 作用：生成给 TUI 展示的短提示，帮助用户决定是否切到回退目录继续。
 * 调用关系：由交互式恢复流程调用，通常和 `getMissingSessionCwdIssue()` 配套使用。
 *
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
 * 定位：恢复会话时的强校验入口。
 * 作用：在必须保证旧 cwd 可用的调用点上，把缺失问题直接提升为异常。
 * 调用关系：由严格恢复流程调用；内部先复用 `getMissingSessionCwdIssue()`，再抛出 `MissingSessionCwdError`。
 *
 * @param sessionManager 会话管理器实例
 * @param fallbackCwd 当前实际的工作目录
 * @throws {MissingSessionCwdError} 如果会话 cwd 不存在
 */
export function assertSessionCwdExists(sessionManager: SessionCwdSource, fallbackCwd: string): void {
	// 先复用结构化检查逻辑，再把问题包装成统一异常类型。
	const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
	if (issue) {
		throw new MissingSessionCwdError(issue);
	}
}
