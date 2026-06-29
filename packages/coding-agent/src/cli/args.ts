/**
 * CLI 参数解析与帮助信息展示
 *
 * 【文件定位】
 * 此文件是 CLI 层的核心参数处理模块，负责将用户在命令行输入的原始字符串数组
 * 解析为结构化的 Args 对象。它是连接"用户输入"和"应用逻辑"的桥梁。
 *
 * 【在调用链中的位置】
 * 用户命令行输入 → bun/cli.ts 或 node/cli.ts → ../cli.ts（主入口）
 *   → parseArgs(args) → Args 对象 → 根据 Args 决定运行模式
 *     → 交互模式（InteractiveMode）
 *     → 打印模式（runPrintMode）
 *     → RPC 模式（runRpcMode）
 *     → 列出模型（listModels）
 *     → 导出 HTML（exportHtml）
 *     → 显示帮助（printHelp）
 *
 * 【提供的能力】
 * 1. Args 接口：定义所有支持的 CLI 参数结构
 * 2. parseArgs()：将字符串数组解析为 Args 对象
 * 3. printHelp()：输出格式化的帮助信息（含扩展标志）
 * 4. isValidThinkingLevel()：验证思考级别参数的合法性
 *
 * 【参数分类概览】
 * - 模型相关：--provider, --model, --api-key, --models
 * - 会话相关：--continue, --resume, --session, --fork, --session-dir, --no-session
 * - 提示相关：--system-prompt, --append-system-prompt
 * - 工具相关：--tools, --no-tools, --no-builtin-tools
 * - 扩展相关：--extension, --no-extensions
 * - 技能/模板相关：--skill, --no-skills, --prompt-template, --no-prompt-templates
 * - 主题相关：--theme, --no-themes
 * - 输出相关：--print, --mode, --export, --list-models
 * - 其他：--thinking, --verbose, --offline, --help, --version
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../config.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";

/**
 * 输出模式类型
 * - "text": 纯文本输出（默认），仅输出最终回复内容
 * - "json": JSON 事件流输出，输出所有会话事件为 JSON 行
 * - "rpc": RPC 模式，用于将 agent 嵌入其他应用，通过 stdin/stdout 进行 JSON 通信
 */
export type Mode = "text" | "json" | "rpc";

/**
 * CLI 参数的结构化表示
 *
 * 由 parseArgs() 解析生成，随后传递给各运行模式使用。
 * 包含了 pi agent 所有可配置的启动参数。
 */
export interface Args {
	/** AI 模型提供商名称，如 "anthropic"、"openai" */
	provider?: string;
	/** 模型 ID 或模式，支持 "provider/id" 格式和 ":<thinking>" 后缀 */
	model?: string;
	/** API 密钥（优先级高于环境变量） */
	apiKey?: string;
	/** 自定义系统提示词（替换默认的编程助手提示词） */
	systemPrompt?: string;
	/** 追加到默认系统提示词后面的文本（可多次使用） */
	appendSystemPrompt?: string[];
	/** 思考级别：off/minimal/low/medium/high/xhigh，控制模型的推理深度 */
	thinking?: ThinkingLevel;
	/** 是否继续上一次会话（-c 标志） */
	continue?: boolean;
	/** 是否通过 TUI 选择器恢复历史会话（-r 标志） */
	resume?: boolean;
	/** 是否显示帮助信息 */
	help?: boolean;
	/** 是否显示版本号 */
	version?: boolean;
	/** 输出模式：text（默认）、json、rpc */
	mode?: Mode;
	/** 是否不保存会话（临时会话模式） */
	noSession?: boolean;
	/** 指定要使用的会话文件路径或部分 UUID */
	session?: string;
	/** 从指定会话/消息 ID 分叉出新会话 */
	fork?: string;
	/** 会话存储目录路径 */
	sessionDir?: string;
	/** 模型循环列表（Ctrl+P 切换），支持 glob 和模糊匹配 */
	models?: string[];
	/** 工具白名单（仅启用列出的工具） */
	tools?: string[];
	/** 禁用所有工具（内置和扩展） */
	noTools?: boolean;
	/** 仅禁用内置工具，保留扩展/自定义工具 */
	noBuiltinTools?: boolean;
	/** 额外加载的扩展文件路径列表 */
	extensions?: string[];
	/** 禁用扩展自动发现（显式 -e 路径仍有效） */
	noExtensions?: boolean;
	/** 非交互模式：处理提示后退出 */
	print?: boolean;
	/** 将会话导出为 HTML 文件 */
	export?: string;
	/** 禁用技能加载 */
	noSkills?: boolean;
	/** 要加载的技能文件/目录列表 */
	skills?: string[];
	/** 要加载的提示模板文件/目录列表 */
	promptTemplates?: string[];
	/** 禁用提示模板加载 */
	noPromptTemplates?: boolean;
	/** 要加载的主题文件/目录列表 */
	themes?: string[];
	/** 禁用主题加载 */
	noThemes?: boolean;
	/** 禁用 AGENTS.md 和 CLAUDE.md 上下文文件加载 */
	noContextFiles?: boolean;
	/** 列出可用模型（可选模糊搜索模式） */
	listModels?: string | true;
	/** 禁用启动时的网络操作 */
	offline?: boolean;
	/** 强制显示详细启动信息 */
	verbose?: boolean;
	/** 用户输入的消息文本（非标志参数） */
	messages: string[];
	/** @file 形式的文件参数列表（去除 @ 前缀后的路径） */
	fileArgs: string[];
	/** 未识别的标志（可能是扩展注册的标志），键值对映射 */
	unknownFlags: Map<string, boolean | string>;
	/** 解析过程中的诊断信息（警告和错误） */
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

/** 合法的思考级别值列表 */
const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * 验证字符串是否为合法的思考级别
 *
 * 【被谁调用】
 * parseArgs() 内部解析 --thinking 参数时调用
 *
 * @param level 待验证的字符串
 * @returns 是否为合法的 ThinkingLevel
 */
export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

/**
 * 将原始命令行参数字符串数组解析为结构化的 Args 对象
 *
 * 【被谁调用】
 * ../cli.ts（主 CLI 入口）在启动时调用
 *
 * 【调用了谁】
 * - isValidThinkingLevel()：验证 --thinking 参数值
 *
 * 【解析规则】
 * 1. 以 -- 或 - 开头的为标志参数
 * 2. @ 开头的为文件参数（存储到 fileArgs，去除 @ 前缀）
 * 3. 其余为消息文本（存储到 messages）
 * 4. 未知的 -- 标志存入 unknownFlags（可能由扩展注册）
 * 5. 未知的 - 短标志记录为错误诊断
 *
 * 【特殊处理】
 * - --print/-p 可以紧随一个消息文本（不带空格分隔也行）
 * - --list-models 后可选跟搜索模式
 * - --models 支持逗号分隔的多个模式
 * - --tools 支持逗号分隔的多个工具名
 * - 未知标志支持 --flag=value 和 --flag value 两种语法
 *
 * @param args 原始命令行参数字符串数组（不含 node 和脚本路径）
 * @returns 解析后的 Args 结构化对象
 */
export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		// ==================== 帮助和版本 ====================
		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;

			// ==================== 输出模式 ====================
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc") {
				result.mode = mode;
			}

			// ==================== 会话控制 ====================
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;

			// ==================== 模型配置 ====================
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];

			// ==================== 系统提示词 ====================
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(args[++i]);

			// ==================== 会话文件 ====================
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session" && i + 1 < args.length) {
			result.session = args[++i];
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];

			// ==================== 模型循环列表 ====================
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map((s) => s.trim());

			// ==================== 工具控制 ====================
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			result.tools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);

			// ==================== 思考级别 ====================
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}

			// ==================== 打印模式 ====================
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			// --print 后可选跟随一个消息文本（如果不是标志或 @file 参数）
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}

			// ==================== 导出 ====================
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];

			// ==================== 扩展 ====================
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;

			// ==================== 技能 ====================
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);

			// ==================== 提示模板 ====================
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);

			// ==================== 主题 ====================
		} else if (arg === "--theme" && i + 1 < args.length) {
			result.themes = result.themes ?? [];
			result.themes.push(args[++i]);

			// ==================== 禁用标志 ====================
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;

			// ==================== 列出模型 ====================
		} else if (arg === "--list-models") {
			// 检查下一个参数是否为搜索模式（非标志、非文件参数）
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}

			// ==================== 调试和离线 ====================
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--offline") {
			result.offline = true;

			// ==================== 文件参数（@file） ====================
		} else if (arg.startsWith("@")) {
			// 移除 @ 前缀，存储文件路径
			result.fileArgs.push(arg.slice(1));

			// ==================== 未知的长标志 ====================
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				// --flag=value 格式
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					// --flag value 格式
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					// --flag（布尔标志，无值）
					result.unknownFlags.set(flagName, true);
				}
			}

			// ==================== 未知的短标志 ====================
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });

			// ==================== 普通消息文本 ====================
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

/**
 * 输出格式化的帮助信息到控制台
 *
 * 【被谁调用】
 * ../cli.ts 在用户指定 --help/-h 参数时调用
 *
 * 【调用了谁】
 * - chalk：用于终端文本加粗等格式化
 * - APP_NAME, CONFIG_DIR_NAME 等配置常量
 *
 * 【功能说明】
 * 输出完整的使用说明，包括：
 * - 用法概览
 * - 命令列表（install/remove/update/list/config）
 * - 所有选项说明
 * - 扩展注册的自定义标志（如有）
 * - 使用示例
 * - 环境变量说明
 * - 内置工具名称列表
 *
 * @param extensionFlags 扩展注册的自定义 CLI 标志列表（可选）
 */
export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	// 构建扩展标志的显示文本
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI Flags:")}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						return `  --${flag.name}${value}`.padEnd(30) + description;
					})
					.join("\n")}\n`
			: "";
	console.log(`${chalk.bold(APP_NAME)} - AI coding assistant with read, bash, edit, write tools

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [@files...] [messages...]

${chalk.bold("Commands:")}
  ${APP_NAME} install <source> [-l]     Install extension source and add to settings
  ${APP_NAME} remove <source> [-l]      Remove extension source from settings
  ${APP_NAME} uninstall <source> [-l]   Alias for remove
  ${APP_NAME} update [source|self|pi]   Update pi and installed extensions
  ${APP_NAME} list                      List installed extensions from settings
  ${APP_NAME} config                    Open TUI to enable/disable package resources
  ${APP_NAME} <command> --help          Show help for install/remove/uninstall/update/list

${chalk.bold("Options:")}
  --provider <name>              Provider name (anthropic, openai)
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --api-key <key>                API key (defaults to env vars)
  --system-prompt <text>         System prompt (default: coding assistant prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)
  --mode <mode>                  Output mode: text (default), json, or rpc
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --resume, -r                   Select a session to resume
  --session <path|id>            Use specific session file or partial UUID
  --fork <path|id>               Fork specific session file or partial UUID into a new session
  --session-dir <dir>            Directory for session storage and lookup
  --no-session                   Don't save session (ephemeral)
  --models <patterns>            Comma-separated model patterns for Ctrl+P cycling
                                 Supports globs (anthropic/*, *sonnet*) and fuzzy matching
  --no-tools, -nt                Disable all tools by default (built-in and extension)
  --no-builtin-tools, -nbt       Disable built-in tools by default but keep extension/custom tools enabled
  --tools, -t <tools>            Comma-separated allowlist of tool names to enable
                                 Applies to built-in, extension, and custom tools
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --theme <path>                 Load a theme file or directory (can be used multiple times)
  --no-themes                    Disable theme discovery and loading
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  --export <file>                Export session file to HTML and exit
  --list-models [search]         List available models (with optional fuzzy search)
  --verbose                      Force verbose startup (overrides quietStartup setting)
  --offline                      Disable startup network operations (same as PI_OFFLINE=1)
  --help, -h                     Show this help
  --version, -v                  Show version number

Extensions can register additional flags (e.g., --plan from plan-mode extension).${extensionFlagsText}

${chalk.bold("Examples:")}
  # Interactive mode
  ${APP_NAME}

  # Interactive mode with initial prompt
  ${APP_NAME} "List all .ts files in src/"

  # Include files in initial message
  ${APP_NAME} @prompt.md @image.png "What color is the sky?"

  # Non-interactive mode (process and exit)
  ${APP_NAME} -p "List all .ts files in src/"

  # Multiple messages (interactive)
  ${APP_NAME} "Read package.json" "What dependencies do we have?"

  # Continue previous session
  ${APP_NAME} --continue "What did we discuss?"

  # Use different model
  ${APP_NAME} --provider openai --model gpt-4o-mini "Help me refactor this code"

  # Use model with provider prefix (no --provider needed)
  ${APP_NAME} --model openai/gpt-4o "Help me refactor this code"

  # Use model with thinking level shorthand
  ${APP_NAME} --model sonnet:high "Solve this complex problem"

  # Limit model cycling to specific models
  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o

  # Limit to a specific provider with glob pattern
  ${APP_NAME} --models "openai/*"

  # Cycle models with fixed thinking levels
  ${APP_NAME} --models sonnet:high,haiku:low

  # Start with a specific thinking level
  ${APP_NAME} --thinking high "Solve this complex problem"

  # Read-only mode (no file modifications possible)
  ${APP_NAME} --tools read,grep,find,ls -p "Review the code in src/"

  # Export a session file to HTML
  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/agent/sessions/--path--/session.jsonl
  ${APP_NAME} --export session.jsonl output.html

${chalk.bold("Environment Variables:")}
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  OPENAI_API_KEY                   - OpenAI GPT API key (also used for OpenAI-compatible endpoints)
  OPENROUTER_API_KEY               - OpenRouter API key (for image generation)
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
  ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
  PI_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
  PI_OFFLINE                       - Disable startup network operations when set to 1/true/yes
  PI_TELEMETRY                     - Override install telemetry when set to 1/true/yes or 0/false/no
  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)

${chalk.bold("Built-in Tool Names:")}
  read   - Read file contents
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  grep   - Search file contents (read-only, off by default)
  find   - Find files by glob pattern (read-only, off by default)
  ls     - List directory contents (read-only, off by default)
`);
}
