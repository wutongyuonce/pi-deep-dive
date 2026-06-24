/**
 * coding-agent CLI 主入口文件。
 *
 * 本文件是 coding-agent 命令行工具的核心入口，负责将用户输入的命令行参数
 * 解析并转换为 createAgentSession() 的选项，由 SDK 完成实际的会话创建和运行。
 *
 * 核心职责：
 * 1. CLI 参数解析（通过 parseArgs）
 * 2. 应用模式决策（interactive / print / json / rpc）
 * 3. 会话管理器创建（新建 / 继续 / 恢复 / 分叉）
 * 4. 运行时服务初始化（auth、settings、model registry、extensions 等）
 * 5. 模型解析和会话选项构建
 * 6. 根据模式启动不同的运行方式（InteractiveMode / runPrintMode / runRpcMode）
 *
 * 调用链路：
 * - 被 cli.ts 的 main(argv) 调用
 * - 调用 parseArgs() 解析命令行参数
 * - 调用 createSessionManager() 创建会话管理器
 * - 调用 createAgentSessionRuntime() 初始化运行时（内部调用 createAgentSessionServices()）
 * - 调用 migrations.ts 的 runMigrations() 执行数据迁移
 * - 调用 package-manager-cli.ts 的 handlePackageCommand / handleConfigCommand 处理包管理命令
 * - 调用 core/ 下的各种服务工厂（AuthStorage、SettingsManager、ModelRegistry 等）
 * - 最终调用 InteractiveMode.run() / runPrintMode() / runRpcMode() 启动运行
 */

import { createInterface } from "node:readline";
import { type ImageContent, modelsAreEqual } from "@earendil-works/pi-ai";
import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Args, type Mode, parseArgs, printHelp } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { selectSession } from "./cli/session-picker.ts";
import { ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir, VERSION } from "./config.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { ExtensionFactory } from "./core/extensions/types.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { KeybindingsManager } from "./core/keybindings.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import { SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

/**
 * 从管道 stdin 读取所有输入内容。
 *
 * 作用：当用户通过管道将内容传入进程时（例如 `echo "hello" | pi`），
 * 读取并返回完整的 stdin 内容。如果 stdin 是交互式终端（TTY），则返回 undefined。
 *
 * 返回值：管道输入的内容字符串，如果 stdin 是 TTY 则返回 undefined。
 *
 * 调用者：main() 函数中在 RPC 模式以外的场景下读取管道输入。
 * 调用了：process.stdin API。
 */
async function readPipedStdin(): Promise<string | undefined> {
	// 如果 stdin 是 TTY（交互式终端），则不读取 stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

/**
 * 收集 SettingsManager 中积累的诊断错误信息。
 *
 * 作用：从 SettingsManager 中提取所有配置加载过程中产生的错误，
 * 并转换为统一的诊断信息格式。
 *
 * 参数：
 * - settingsManager: 设置管理器实例
 * - context: 错误上下文描述（如 "startup session lookup"、"runtime creation"）
 *
 * 返回值：诊断信息数组（类型为 warning）。
 *
 * 调用者：main() 函数中在启动阶段和运行时创建阶段收集诊断信息。
 * 调用了：SettingsManager.drainErrors()。
 */
function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

/**
 * 将诊断信息输出到 stderr。
 *
 * 作用：根据诊断信息的类型（error/warning/info），使用不同颜色将信息输出到 stderr。
 *
 * 参数：
 * - diagnostics: 只读的诊断信息数组。
 *
 * 调用者：main() 函数中在启动阶段和运行时创建后报告诊断信息。
 * 调用了：console.error、chalk。
 */
function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

/**
 * 判断环境变量值是否为"真值"。
 *
 * 作用：检查环境变量字符串是否表示启用状态。
 * 接受的真值："1"、"true"、"yes"（不区分大小写）。
 *
 * 参数：
 * - value: 环境变量值，可能为 undefined。
 *
 * 返回值：布尔值，表示是否为真值。
 *
 * 调用者：main() 函数中检查 PI_OFFLINE 和 PI_STARTUP_BENCHMARK 环境变量。
 */
function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * 应用运行模式类型。
 *
 * - interactive: 交互式终端模式，提供完整的 TUI 界面
 * - print: 单次输出模式（-p/--print 或管道输入），输出文本结果
 * - json: JSON 输出模式，输出结构化 JSON 结果
 * - rpc: JSON-RPC 模式，通过 stdin/stdout 进行 RPC 通信
 */
type AppMode = "interactive" | "print" | "json" | "rpc";

/**
 * 根据解析后的参数和 stdin 状态确定应用运行模式。
 *
 * 决策逻辑（优先级从高到低）：
 * 1. 显式指定 --mode rpc → "rpc"
 * 2. 显式指定 --mode json → "json"
 * 3. 使用了 -p/--print 标志，或 stdin 不是 TTY（有管道输入）→ "print"
 * 4. 其他情况 → "interactive"
 *
 * 参数：
 * - parsed: 解析后的 CLI 参数对象
 * - stdinIsTTY: stdin 是否为交互式终端
 *
 * 返回值：应用运行模式。
 *
 * 调用者：main() 函数中在参数解析后确定运行模式。
 */
function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY) {
		return "print";
	}
	return "interactive";
}

/**
 * 将 AppMode 转换为 print 模式的输出格式。
 *
 * 作用：将应用模式映射为 runPrintMode 所需的输出格式。
 * json 模式返回 "json"，其他模式返回 "text"。
 *
 * 参数：
 * - appMode: 应用运行模式（排除 "rpc"）。
 *
 * 返回值：输出模式（"json" 或 "text"）。
 *
 * 调用者：main() 函数中在 print 模式下启动 runPrintMode 时使用。
 */
function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

/**
 * 准备会话的初始消息。
 *
 * 作用：根据 CLI 参数、文件参数和管道输入内容，构建会话的初始消息。
 * 如果有文件参数（@file），先通过 processFileArguments 处理文件内容，
 * 再通过 buildInitialMessage 组装最终的初始消息。
 *
 * 参数：
 * - parsed: 解析后的 CLI 参数对象
 * - autoResizeImages: 是否自动调整图片大小
 * - stdinContent: 从管道 stdin 读取的内容（可选）
 *
 * 返回值：包含 initialMessage（文本）和 initialImages（图片）的对象。
 *
 * 调用者：main() 函数中在读取管道输入后准备初始消息。
 * 调用了：processFileArguments()（处理 @file 参数）、buildInitialMessage()（组装消息）。
 */
async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/**
 * 会话参数解析结果类型。
 *
 * 表示通过 --session 或 --fork 参数指定的会话解析后的结果：
 * - path: 直接指定了文件路径（如 /path/to/session.jsonl）
 * - local: 在当前项目中找到了匹配的会话（通过 ID 前缀匹配）
 * - global: 在其他项目中找到了匹配的会话（需要用户确认是否分叉）
 * - not_found: 在任何地方都没有找到匹配的会话
 */
type ResolvedSession =
	| { type: "path"; path: string } // 直接文件路径
	| { type: "local"; path: string } // 在当前项目中找到
	| { type: "global"; path: string; cwd: string } // 在其他项目中找到
	| { type: "not_found"; arg: string }; // 未找到

/**
 * 将会话参数解析为文件路径。
 *
 * 解析策略：
 * 1. 如果参数看起来像文件路径（包含 / 或 \，或以 .jsonl 结尾），直接作为路径使用
 * 2. 否则，先在当前项目的会话目录中按 ID 前缀匹配
 * 3. 如果本地未找到，在所有项目的会话中全局搜索
 * 4. 如果都未找到，返回 not_found 状态
 *
 * 参数：
 * - sessionArg: 用户传入的会话参数（路径或 ID 前缀）
 * - cwd: 当前工作目录
 * - sessionDir: 自定义会话目录（可选）
 *
 * 返回值：ResolvedSession 解析结果。
 *
 * 调用者：createSessionManager() 函数中解析 --session 和 --fork 参数。
 * 调用了：resolvePath()、SessionManager.list()、SessionManager.listAll()。
 */
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// 如果看起来像文件路径，在交给会话管理器之前先解析它
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// 先在当前项目的会话目录中按 ID 前缀匹配
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatches = localSessions.filter((s) => s.id.startsWith(sessionArg));

	if (localMatches.length >= 1) {
		return { type: "local", path: localMatches[0].path };
	}

	// 本地未找到，在所有项目的会话中全局搜索
	const allSessions = await SessionManager.listAll();
	const globalMatches = allSessions.filter((s) => s.id.startsWith(sessionArg));

	if (globalMatches.length >= 1) {
		const match = globalMatches[0];
		return { type: "global", path: match.path, cwd: match.cwd };
	}

	// 在任何地方都未找到
	return { type: "not_found", arg: sessionArg };
}

/**
 * 在终端中提示用户确认 yes/no。
 *
 * 作用：通过 readline 接口向用户显示确认提示，等待用户输入 y/n。
 *
 * 参数：
 * - message: 提示消息内容。
 *
 * 返回值：用户是否确认（true 表示确认）。
 *
 * 调用者：createSessionManager() 函数中当会话在其他项目中找到时，
 *         提示用户是否将其分叉到当前目录。
 * 调用了：node:readline 的 createInterface。
 */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

/**
 * 验证 --fork 标志是否与其他冲突标志同时使用。
 *
 * 冲突标志：--session、--continue、--resume、--no-session。
 * 如果同时使用了冲突标志，输出错误信息并退出进程。
 *
 * 参数：
 * - parsed: 解析后的 CLI 参数对象。
 *
 * 调用者：main() 函数中在参数解析后、创建会话管理器前进行验证。
 */
function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

/**
 * 从源会话分叉创建新会话，失败时退出进程。
 *
 * 作用：调用 SessionManager.forkFrom() 从指定的源会话创建分叉。
 * 如果分叉失败，输出错误信息并以退出码 1 终止进程。
 *
 * 参数：
 * - sourcePath: 源会话的文件路径
 * - cwd: 当前工作目录
 * - sessionDir: 自定义会话目录（可选）
 *
 * 返回值：分叉后的 SessionManager 实例。
 *
 * 调用者：createSessionManager() 函数中处理 --fork 和跨项目 --session 时。
 * 调用了：SessionManager.forkFrom()。
 */
function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

/**
 * 根据 CLI 参数创建会话管理器。
 *
 * 这是会话创建的核心决策函数，根据不同的 CLI 参数选择不同的会话管理策略：
 *
 * 决策逻辑（优先级从高到低）：
 * 1. --no-session: 创建内存会话（不持久化）
 * 2. --fork <arg>: 从指定会话分叉（解析 arg 后调用 forkSessionOrExit）
 * 3. --session <arg>: 打开指定会话
 *    - 本地匹配：直接打开
 *    - 全局匹配（其他项目）：提示用户是否分叉到当前目录
 *    - 未找到：报错退出
 * 4. --resume: 显示交互式会话选择器（selectSession），让用户选择历史会话
 * 5. --continue: 继续最近的会话（SessionManager.continueRecent）
 * 6. 默认: 创建新会话（SessionManager.create）
 *
 * 参数：
 * - parsed: 解析后的 CLI 参数对象
 * - cwd: 当前工作目录
 * - sessionDir: 自定义会话目录（可选）
 * - settingsManager: 启动阶段的设置管理器（用于获取主题设置）
 *
 * 返回值：SessionManager 实例。
 *
 * 调用者：main() 函数中在参数解析和迁移后创建会话管理器。
 * 调用了：resolveSessionPath()、forkSessionOrExit()、promptConfirm()、
 *         selectSession()、SessionManager 的各种工厂方法。
 */
async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	// 优先级 1：--no-session → 内存会话（不持久化到磁盘）
	if (parsed.noSession) {
		return SessionManager.inMemory();
	}

	// 优先级 2：--fork <arg> → 从指定会话分叉
	if (parsed.fork) {
		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	// 优先级 3：--session <arg> → 打开指定会话
	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				// 本地或直接路径匹配：直接打开
				return SessionManager.open(resolved.path, sessionDir);

			case "global": {
				// 全局匹配（其他项目）：提示用户是否分叉到当前目录
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	// 优先级 4：--resume → 显示交互式会话选择器
	if (parsed.resume) {
		initTheme(settingsManager.getTheme(), true);
		try {
			const selectedPath = await selectSession(
				(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
				SessionManager.listAll,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedPath, sessionDir);
		} finally {
			stopThemeWatcher();
		}
	}

	// 优先级 5：--continue → 继续最近的会话
	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	// 默认：创建新会话
	return SessionManager.create(cwd, sessionDir);
}

/**
 * 根据 CLI 参数构建会话选项。
 *
 * 作用：将解析后的 CLI 参数和模型作用域转换为 createAgentSession 所需的选项对象。
 * 处理以下逻辑：
 * 1. CLI 指定的模型（--model、--provider）：通过 resolveCliModel 解析
 * 2. 默认模型选择：优先使用用户保存的默认模型（如果在作用域内），否则使用第一个作用域模型
 * 3. 思考级别（thinking level）：CLI 显式指定 > 模型模式中的级别 > 作用域配置
 * 4. 作用域模型列表：用于 Ctrl+P 切换模型
 * 5. 工具配置：--no-tools、--no-builtin-tools、--tools
 *
 * 参数：
 * - parsed: 解析后的 CLI 参数对象
 * - scopedModels: 模型作用域列表（由 resolveModelScope 解析）
 * - hasExistingSession: 是否有已存在的会话消息（影响默认模型选择）
 * - modelRegistry: 模型注册表
 * - settingsManager: 设置管理器
 *
 * 返回值：包含 options（会话选项）、cliThinkingFromModel（是否从模型模式设置思考级别）、
 *         diagnostics（诊断信息）的对象。
 *
 * 调用者：createRuntime 工厂函数中在创建会话服务后构建选项。
 * 调用了：resolveCliModel()、modelsAreEqual()。
 */
function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// CLI 指定的模型解析（优先级最高）
	// 支持两种格式：--provider <name> --model <pattern>，或 --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// 支持 "--model <pattern>:<thinking>" 作为思考级别的简写。
			// 显式的 --thinking 参数仍然优先（在后面的应用阶段生效）。
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// 检查用户保存的默认模型是否在作用域内：如果在则使用，否则使用第一个作用域模型
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// 使用作用域模型配置中显式设置的思考级别
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// 使用第一个作用域模型中显式设置的思考级别
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// CLI 指定的思考级别（优先级最高，覆盖上面从作用域模型设置的思考级别）
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// 作用域模型列表：用于 Ctrl+P 快捷键切换模型
	// 未显式设置思考级别时保持 undefined，表示"继承当前会话的思考级别"
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// CLI 传入的 API key 在 authStorage 中设置
	//（由调用者在 createAgentSession 之前处理）

	// 工具配置
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

/**
 * 解析 CLI 中指定的路径列表，将相对路径转换为绝对路径。
 *
 * 作用：对于本地路径（相对路径），使用 resolvePath 解析为基于 cwd 的绝对路径。
 * 非本地路径（如 URL 或包名）保持原样。
 *
 * 参数：
 * - cwd: 当前工作目录
 * - paths: 路径列表（可选）
 *
 * 返回值：解析后的路径列表，如果输入为 undefined 则返回 undefined。
 *
 * 调用者：main() 中的 createRuntime 工厂函数中处理 extensions、skills 等路径参数。
 * 调用了：isLocalPath()、resolvePath()。
 */
function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

/**
 * 当会话的工作目录（cwd）缺失或不匹配时，提示用户选择处理方式。
 *
 * 作用：当打开的会话来自另一个已不存在的目录时，使用 TUI 组件提示用户
 * 选择"继续"（使用回退目录）或"取消"。
 *
 * 参数：
 * - issue: 会话 cwd 问题描述对象
 * - settingsManager: 设置管理器（用于获取主题和 TUI 配置）
 *
 * 返回值：用户选择的目录路径，如果取消则返回 undefined。
 *
 * 调用者：main() 函数中检测到会话 cwd 问题且处于交互模式时。
 * 调用了：initTheme()、setKeybindings()、TUI、ExtensionSelectorComponent。
 */
async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
		ui.setClearOnShrink(settingsManager.getClearOnShrink());

		let settled = false;
		const finish = (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			formatMissingSessionCwdPrompt(issue),
			["Continue", "Cancel"],
			(option) => finish(option === "Continue" ? issue.fallbackCwd : undefined),
			() => finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}

/**
 * main() 函数的配置选项。
 *
 * 属性：
 * - extensionFactories: 额外的扩展工厂列表，用于注入自定义扩展（如测试时的 mock 扩展）
 */
export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
}

/**
 * coding-agent CLI 主入口函数。
 *
 * 完整执行流程：
 *
 * 阶段 1 - 初始化和预处理：
 * 1. 重置计时器（resetTimings）
 * 2. 检测离线模式（--offline 或 PI_OFFLINE 环境变量）
 * 3. Windows 平台清理自更新隔离文件
 *
 * 阶段 2 - 包管理命令处理：
 * 4. 检查是否为包管理命令（handlePackageCommand），如果是则处理后返回
 * 5. 检查是否为配置命令（handleConfigCommand），如果是则处理后返回
 *
 * 阶段 3 - 参数解析和模式决策：
 * 6. 解析 CLI 参数（parseArgs），报告诊断信息
 * 7. 确定应用运行模式（resolveAppMode）：interactive / print / json / rpc
 * 8. 非交互模式下接管 stdout（takeOverStdout）以保护输出
 *
 * 阶段 4 - 快速退出路径：
 * 9. --version: 输出版本号后退出
 * 10. --export: 导出会话为 HTML 后退出
 * 11. RPC 模式下禁止 @file 参数
 *
 * 阶段 5 - 会话管理器创建：
 * 12. 验证 --fork 标志冲突（validateForkFlags）
 * 13. 执行数据迁移（runMigrations）
 * 14. 创建启动阶段的 SettingsManager
 * 15. 解析会话目录（sessionDir）
 * 16. 创建会话管理器（createSessionManager），根据 --no-session/--fork/--session/--resume/--continue 决策
 * 17. 处理会话 cwd 缺失问题（promptForMissingSessionCwd）
 *
 * 阶段 6 - 运行时服务初始化：
 * 18. 解析 CLI 路径参数（extensions、skills、promptTemplates、themes）
 * 19. 创建 AuthStorage
 * 20. 定义 createRuntime 工厂函数，内部：
 *    a. 创建会话服务（createAgentSessionServices）
 *    b. 解析模型作用域（resolveModelScope）
 *    c. 构建会话选项（buildSessionOptions）
 *    d. 处理 --api-key 参数
 *    e. 创建会话（createAgentSessionFromServices）
 * 21. 执行运行时创建（createAgentSessionRuntime）
 *
 * 阶段 7 - 后处理和模式启动：
 * 22. --help: 显示帮助信息后退出
 * 23. --list-models: 列出可用模型后退出
 * 24. 读取管道 stdin 输入（readPipedStdin）
 * 25. 准备初始消息（prepareInitialMessage）
 * 26. 初始化主题（initTheme）
 * 27. 显示迁移弃用警告
 * 28. 报告诊断信息，如有错误则退出
 * 29. 根据应用模式启动运行：
 *    - rpc: runRpcMode(runtime)
 *    - interactive: InteractiveMode.run(runtime)
 *    - print/json: runPrintMode(runtime)
 *
 * 参数：
 * - args: 命令行参数数组（不含 node 和脚本路径）
 * - options: 可选配置（如扩展工厂）
 *
 * 调用者：cli.ts 的 main(argv) 函数。
 */
export async function main(args: string[], options?: MainOptions) {
	// 阶段 1：初始化 - 重置计时器，检测离线模式
	resetTimings();
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	// Windows 平台：清理自更新产生的隔离文件
	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}

	// 阶段 2：包管理命令处理 - 如果是 package 或 config 命令则直接处理后返回
	if (await handlePackageCommand(args)) {
		return;
	}

	if (await handleConfigCommand(args)) {
		return;
	}

	// 阶段 3：参数解析和模式决策
	// 解析 CLI 参数，报告解析过程中的诊断信息（如有错误则退出）
	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");
	// 确定应用运行模式：interactive（默认）、print（-p 或管道输入）、json、rpc
	let appMode = resolveAppMode(parsed, process.stdin.isTTY);
	// 非交互模式下接管 stdout，防止第三方库意外输出干扰结构化输出
	const shouldTakeOverStdout = appMode !== "interactive";
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	// 阶段 4：快速退出路径
	// --version: 输出版本号后立即退出
	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	// --export: 将会话导出为 HTML 文件
	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	// RPC 模式下禁止 @file 参数（RPC 使用 stdin 进行 JSON-RPC 通信）
	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	// 阶段 5：会话管理器创建
	// 验证 --fork 标志不与其他冲突标志（--session、--continue、--resume、--no-session）同时使用
	validateForkFlags(parsed);

	// 执行数据迁移（传递 cwd 用于项目本地迁移）
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(process.cwd());
	time("runMigrations");

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	// 创建启动阶段的 SettingsManager（仅用于会话目录查找）
	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));

	// 在创建与 cwd 绑定的运行时服务之前，先确定最终的运行时 cwd。
	// --session 和 --resume 可能选择来自其他项目的会话，因此项目本地的
	// 设置、资源、provider 注册和模型必须在目标会话 cwd 确定后才能解析。
	// 启动阶段的 SettingsManager 仅用于会话选择期间的 sessionDir 查找。
	const envSessionDir = process.env[ENV_SESSION_DIR];
	// 会话目录优先级：CLI --session-dir > 环境变量 PI_SESSION_DIR > 配置文件中的 sessionDir
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	// 创建会话管理器（根据 --no-session/--fork/--session/--resume/--continue 决策）
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	// 检查会话的 cwd 是否存在问题（如原项目目录已不存在）
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		// 交互模式：提示用户选择是否使用回退目录继续
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			// 非交互模式：直接报错退出（无法提示用户）
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	time("createSessionManager");

	// 阶段 6：运行时服务初始化
	// 解析 CLI 中的路径参数（扩展、技能、提示模板、主题的路径）
	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	// 创建认证存储（管理 API key 等凭据）
	const authStorage = AuthStorage.create();
	// 定义运行时创建工厂函数 - 此函数在 createAgentSessionRuntime 内部被调用
	// 接收 cwd、agentDir、sessionManager、sessionStartEvent 参数
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		// 创建会话所需的所有服务（auth、settings、model registry、extensions 等）
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories: options?.extensionFactories,
			},
		});
		const { settingsManager, modelRegistry, resourceLoader } = services;
		// 收集诊断信息：来自服务创建、设置错误、扩展加载错误
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager, "runtime creation"),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];

		// 解析模型作用域：从 CLI --models 或设置中的 enabledModels 解析可用模型列表
		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0, // 是否有已存在的会话消息
			modelRegistry,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		// 处理 CLI 传入的 API key（需要先有模型才能设置）
		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		// 创建会话实例（使用构建好的选项）
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});
		// 如果 CLI 显式指定了思考级别（或从模型模式中提取），则强制设置
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	// 执行运行时创建（调用上面定义的 createRuntime 工厂函数）
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRegistry, resourceLoader } = services;
	// 配置 HTTP 请求分发器的空闲超时时间
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	// 阶段 7：后处理和模式启动
	// --help: 显示帮助信息（包含扩展注册的自定义标志）后退出
	if (parsed.help) {
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		process.exit(0);
	}

	// --list-models: 列出可用模型（可选按搜索模式过滤）后退出
	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	// 读取管道 stdin 内容（RPC 模式跳过，因为 stdin 用于 JSON-RPC 通信）
	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		stdinContent = await readPipedStdin();
		// 如果交互模式下有管道输入，自动切换为 print 模式
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	// 准备初始消息（合并 CLI 消息、@file 参数、管道输入）
	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	// 初始化主题（交互模式下启动文件监听器以支持实时主题切换）
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	// 在交互模式下显示迁移产生的弃用警告
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	time("resolveModelScope");
	// 报告所有诊断信息，如有错误级别诊断则退出
	reportDiagnostics(runtime.diagnostics);
	if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		process.exit(1);
	}
	time("createAgentSession");

	// 非交互模式下如果没有可用模型，报错退出（交互模式允许无模型启动，后续可手动选择）
	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	// 启动性能基准测试模式（仅支持交互模式）
	const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	// 根据应用模式启动对应的运行方式
	if (appMode === "rpc") {
		// RPC 模式：通过 stdin/stdout 进行 JSON-RPC 通信
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		// 交互式模式：创建完整的 TUI 界面
		const interactiveMode = new InteractiveMode(runtime, {
			migratedProviders,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
		});
		// 启动性能基准测试：仅初始化 TUI 后立即退出，用于测量启动时间
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			printTimings();
			interactiveMode.stop();
			stopThemeWatcher();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		// print/json 模式：单次输出模式，执行完成后退出
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
