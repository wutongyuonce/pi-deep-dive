/**
 * 斜杠命令定义模块
 *
 * 定义了 TUI 交互模式下可用的所有内置斜杠命令（/settings、/model、/login 等）。
 * 斜杠命令还可以来自扩展、提示词模板和技能，本模块定义了它们的来源类型和信息结构。
 */

import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

/** 斜杠命令的来源类型 */
export type SlashCommandSource = "extension" | "prompt" | "skill";

/**
 * 斜杠命令信息
 * 描述一个可用的斜杠命令，包括其名称、描述、来源和来源详情。
 */
export interface SlashCommandInfo {
	/** 命令名称（不含前导斜杠） */
	name: string;
	/** 命令描述（可选） */
	description?: string;
	/** 命令来源：extension（扩展）、prompt（提示词模板）、skill（技能） */
	source: SlashCommandSource;
	/** 来源详情 */
	sourceInfo: SourceInfo;
}

/**
 * 内置斜杠命令定义
 */
export interface BuiltinSlashCommand {
	/** 命令名称 */
	name: string;
	/** 命令描述 */
	description: string;
}

/** 内置斜杠命令列表 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
