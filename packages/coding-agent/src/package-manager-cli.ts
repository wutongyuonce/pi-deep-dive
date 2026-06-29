/**
 * 包管理 CLI 命令处理模块
 *
 * 本文件是 pi CLI 中包管理命令的核心处理入口，负责解析和执行以下命令：
 *   - install  ：安装一个包并写入 settings 配置
 *   - remove   ：移除一个包并从 settings 配置中删除
 *   - update   ：更新 pi 自身和/或已安装的扩展包
 *   - list     ：列出用户级和项目级已配置的包
 *   - config   ：启动交互式配置选择器
 *
 * 调用链路：
 *   - 被 main.ts 的 handlePackageCommand / handleConfigCommand 调用来分发命令
 *   - 调用 config.ts 的 detectInstallMethod、getSelfUpdateCommand 等获取安装方式和更新命令
 *   - 调用 core/package-manager.ts 的 DefaultPackageManager 执行实际的包管理操作
 *   - 调用 utils/version-check.ts 的 getLatestPiRelease 检查最新版本
 *   - 调用 utils/child-process.ts 的 spawnProcess 执行子进程（自更新命令）
 *   - 调用 cli/config-selector.ts 的 selectConfig 启动交互式配置
 */
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { selectConfig } from "./cli/config-selector.ts";
import {
	APP_NAME,
	detectInstallMethod,
	getAgentDir,
	getPackageDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	type SelfUpdateCommand,
	VERSION,
} from "./config.ts";
import { DefaultPackageManager } from "./core/package-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { spawnProcess } from "./utils/child-process.ts";
import { getLatestPiRelease, isNewerPackageVersion } from "./utils/version-check.ts";
import {
	cleanupWindowsSelfUpdateQuarantine,
	quarantineWindowsNativeDependencies,
} from "./utils/windows-self-update.ts";

/** 支持的包管理命令类型：安装、移除、更新、列表 */
export type PackageCommand = "install" | "remove" | "update" | "list";

/**
 * update 命令的更新目标类型
 *   - all        ：同时更新 pi 自身和所有扩展包
 *   - self       ：仅更新 pi 自身
 *   - extensions ：更新扩展包，可选指定单个 source
 */
type UpdateTarget = { type: "all" } | { type: "self" } | { type: "extensions"; source?: string };

/** 自更新完成后显示更新笔记时使用的 Markdown 主题，采用黄色调突出标题和代码 */
const SELF_UPDATE_NOTE_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => chalk.bold(chalk.yellow(text)),
	link: (text) => chalk.cyan(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.dim(text),
	codeBlockBorder: (text) => chalk.dim(text),
	quote: (text) => chalk.dim(text),
	quoteBorder: (text) => chalk.dim(text),
	hr: (text) => chalk.dim(text),
	listBullet: (text) => chalk.yellow(text),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	strikethrough: (text) => chalk.strikethrough(text),
	underline: (text) => chalk.underline(text),
};

/**
 * 解析后的包管理命令选项
 * 由 parsePackageCommand 解析命令行参数后生成，供 handlePackageCommand 使用
 */
interface PackageCommandOptions {
	/** 要执行的命令类型 */
	command: PackageCommand;
	/** 包来源标识（如 npm:@foo/bar、git:github.com/user/repo、本地路径等） */
	source?: string;
	/** update 命令的更新目标，由 --self / --extensions / --extension / 位置参数组合决定 */
	updateTarget?: UpdateTarget;
	/** 是否安装/移除到项目级配置（.pi/settings.json） */
	local: boolean;
	/** 是否强制更新（即使已是最新版本也重新安装） */
	force: boolean;
	/** 是否显示帮助信息 */
	help: boolean;
	/** 记录第一个无效的选项（如不支持的 flag） */
	invalidOption?: string;
	/** 记录第一个多余的非选项参数 */
	invalidArgument?: string;
	/** 记录第一个缺少值的选项（如 --extension 后未跟 source） */
	missingOptionValue?: string;
	/** 记录互斥选项冲突的描述信息 */
	conflictingOptions?: string;
}

/**
 * 将 SettingsManager 中累积的配置解析错误以警告形式输出到 stderr
 * 被 handleConfigCommand 和 handlePackageCommand 在创建 SettingsManager 后调用
 * 内部调用 settingsManager.drainErrors() 获取并清空错误队列
 */
function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

/**
 * 返回指定命令的用法字符串，用于错误提示和帮助信息
 * 被 printPackageCommandHelp 和 handlePackageCommand 的错误分支调用
 */
function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l]`;
		case "update":
			return `${APP_NAME} update [source|self|pi] [--self] [--extensions] [--extension <source>] [--force]`;
		case "list":
			return `${APP_NAME} list`;
	}
}

/**
 * 打印指定命令的详细帮助信息（用法、选项、示例）
 * 被 handlePackageCommand 在用户传入 -h/--help 时调用
 */
function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local    Install project-locally (.pi/settings.json)

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.
Alias: ${APP_NAME} uninstall <source> [-l]

Options:
  -l, --local    Remove from project settings (.pi/settings.json)

Examples:
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update pi and installed packages.

Options:
  --self                  Update pi only
  --extensions            Update installed packages only
  --extension <source>    Update one package only
  --force                 Reinstall pi even if the current version is latest

Short forms:
  ${APP_NAME} update                Update pi and all extensions
  ${APP_NAME} update <source>       Update one package
  ${APP_NAME} update pi             Update pi only (self works as alias to pi)
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.
`);
			return;
	}
}

/**
 * 解析命令行参数，返回结构化的 PackageCommandOptions
 *
 * 解析流程：
 *   1. 从 args[0] 提取命令名（uninstall 映射为 remove）
 *   2. 遍历剩余参数，按前缀识别选项：
 *      - -h/--help        → 设置 help 标志
 *      - -l/--local       → 设置 local 标志（仅 install/remove 有效）
 *      - --self           → 设置 selfFlag（仅 update 有效）
 *      - --extensions     → 设置 extensionsFlag（仅 update 有效）
 *      - --force          → 设置 force 标志（仅 update 有效）
 *      - --extension <s>  → 读取下一个参数作为 extensionFlagSource（仅 update 有效）
 *      - 以 - 开头但未匹配 → 记录为 invalidOption
 *      - 非选项参数         → 第一个作为 source，后续的记录为 invalidArgument
 *   3. 根据 --self / --extensions / --extension / 位置参数组合推导 updateTarget：
 *      - --extension <s>            → { type: "extensions", source }
 *      - 位置 source = "self"/"pi"  → { type: "self" } 或配合 --extensions 则 { type: "all" }
 *      - 位置 source = 其他         → { type: "extensions", source }
 *      - --self + --extensions      → { type: "all" }
 *      - 仅 --self                  → { type: "self" }
 *      - 仅 --extensions            → { type: "extensions" }
 *      - 都没有                     → { type: "all" }
 *   4. 检测互斥冲突并记录到 conflictingOptions
 *
 * 被 handlePackageCommand 调用；返回 undefined 表示命令名不匹配
 */
function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	// 步骤1：识别命令名，uninstall 是 remove 的别名
	let command: PackageCommand | undefined;
	if (rawCommand === "uninstall") {
		command = "remove";
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	// 步骤2：遍历剩余参数，按选项前缀逐个解析
	let local = false;
	let force = false;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	let source: string | undefined;
	let selfFlag = false;
	let extensionsFlag = false;
	let extensionFlagSource: string | undefined;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--self") {
			if (command === "update") {
				selfFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extensions") {
			if (command === "update") {
				extensionsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--force") {
			if (command === "update") {
				force = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extension") {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}

			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (extensionFlagSource) {
				conflictingOptions = conflictingOptions ?? "--extension can only be provided once";
				index++;
			} else {
				extensionFlagSource = value;
				index++;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	// 步骤3：根据解析出的标志和位置参数推导 updateTarget
	let updateTarget: UpdateTarget | undefined;
	if (command === "update") {
		if (extensionFlagSource) {
			if (selfFlag || extensionsFlag) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with --self or --extensions";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with a positional source";
			}
			updateTarget = { type: "extensions", source: extensionFlagSource };
		} else if (source) {
			const sourceIsSelf = source === "self" || source === "pi";
			if (sourceIsSelf) {
				updateTarget = extensionsFlag ? { type: "all" } : { type: "self" };
			} else {
				if (extensionsFlag || selfFlag) {
					conflictingOptions =
						conflictingOptions ?? "positional update targets cannot be combined with --self or --extensions";
				}
				updateTarget = { type: "extensions", source };
			}
		} else if (selfFlag && extensionsFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag) {
			updateTarget = { type: "self" };
		} else if (extensionsFlag) {
			updateTarget = { type: "extensions" };
		} else {
			updateTarget = { type: "all" };
		}
	}

	return {
		command,
		source,
		updateTarget,
		local,
		force,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

/** 判断更新目标是否包含 pi 自身更新 */
function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "self";
}

/** 判断更新目标是否包含扩展包更新 */
function updateTargetIncludesExtensions(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "extensions";
}

/**
 * 输出自更新不可用的错误信息（当前安装方式不支持自动更新）
 * 被 handlePackageCommand 的 update 分支在 getSelfUpdateCommand 返回 null 时调用
 * 内部调用 config.ts 的 getSelfUpdateUnavailableInstruction 获取具体指引
 */
function printSelfUpdateUnavailable(npmCommand?: string[], updatePackageName = PACKAGE_NAME): void {
	console.error(`error: ${APP_NAME} cannot self-update this installation.`);
	console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME, npmCommand, updatePackageName));

	const entrypoint = process.argv[1];
	if (entrypoint) {
		console.error("");
		console.error(`Location of pi executable: ${entrypoint}`);
	}
}

/**
 * 输出自更新失败时的兜底提示，告诉用户可以手动执行更新命令
 * 被 handlePackageCommand 的 update 分支在 runSelfUpdate 抛出异常时调用
 */
function printSelfUpdateFallback(command: SelfUpdateCommand): void {
	console.error(chalk.dim(`If this keeps failing, run this command yourself: ${command.display}`));
}

/**
 * 将更新笔记（Markdown 格式）渲染并输出到终端
 * 使用 SELF_UPDATE_NOTE_MARKDOWN_THEME 主题进行高亮渲染
 * 被 handlePackageCommand 的 update 分支在自更新前调用
 */
function printSelfUpdateNote(note: string): void {
	const trimmedNote = note.trim();
	if (!trimmedNote) {
		return;
	}

	console.log();
	console.log(chalk.bold(chalk.yellow("Update note")));
	try {
		const width = Math.max(20, process.stdout.columns ?? 80);
		const renderedLines = new Markdown(trimmedNote, 0, 0, SELF_UPDATE_NOTE_MARKDOWN_THEME)
			.render(width)
			.map((line) => line.trimEnd());
		console.log(renderedLines.join("\n"));
	} catch {
		console.log(trimmedNote);
	}
	console.log();
}

/**
 * 自更新计划结果
 * 由 getSelfUpdatePlan 生成，决定是否执行更新以及使用哪个包名
 */
interface SelfUpdatePlan {
	packageName: string;
	shouldRun: boolean;
	note?: string;
}

/**
 * 获取自更新计划：决定是否需要更新以及使用哪个包名
 *
 * 步骤：
 *   1. 如果 force=true，跳过版本检查直接返回 shouldRun=true
 *   2. 调用 getLatestPiRelease(VERSION) 查询最新发布信息
 *   3. 比较最新版本与当前 VERSION：
 *      - 查询失败 → 视为需要更新（容错策略，宁可多更新不漏更新）
 *      - 有新版本 → shouldRun=true，附带更新笔记
 *      - 已是最新 → 输出 "already up to date" 并返回 shouldRun=false
 *
 * 被 handlePackageCommand 的 update 分支调用
 * 调用 utils/version-check.ts 的 getLatestPiRelease 和 isNewerPackageVersion
 */
async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	if (force) {
		return { packageName: PACKAGE_NAME, shouldRun: true };
	}

	try {
		const latestRelease = await getLatestPiRelease(VERSION);
		const packageName = latestRelease?.packageName ?? PACKAGE_NAME;
		if (!latestRelease || packageName !== PACKAGE_NAME || isNewerPackageVersion(latestRelease.version, VERSION)) {
			return { packageName, shouldRun: true, ...(latestRelease?.note ? { note: latestRelease.note } : {}) };
		}
	} catch {
		return { packageName: PACKAGE_NAME, shouldRun: true };
	}

	console.log(chalk.green(`${APP_NAME} is already up to date (v${VERSION})`));
	return { packageName: PACKAGE_NAME, shouldRun: false };
}

/**
 * 执行自更新命令
 * 支持多步骤更新（command.steps）或单步骤更新（command 本身）
 * 每个步骤通过 spawnProcess 以 inherit stdio 方式运行子进程
 * 被 handlePackageCommand 的 update 分支调用
 * 调用 utils/child-process.ts 的 spawnProcess
 */
async function runSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	console.log(chalk.dim(`Updating ${APP_NAME} with ${command.display}...`));
	for (const step of command.steps ?? [command]) {
		await new Promise<void>((resolve, reject) => {
			const child = spawnProcess(step.command, step.args, {
				stdio: "inherit",
			});
			child.on("error", (error) => {
				reject(error);
			});
			child.on("close", (code, signal) => {
				if (code === 0) {
					resolve();
				} else if (signal) {
					reject(new Error(`${step.display} terminated by signal ${signal}`));
				} else {
					reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
				}
			});
		});
	}
}

/**
 * Windows 平台 npm 安装方式的自更新预处理
 * 清理之前的隔离目录，并将原生依赖隔离到临时目录以避免文件锁定问题
 * 非 Windows 平台直接返回
 * 被 handlePackageCommand 的 update 分支在 installMethod === "npm" 时调用
 */
function prepareWindowsNpmSelfUpdate(): void {
	if (process.platform !== "win32") {
		return;
	}

	const packageDir = getPackageDir();
	cleanupWindowsSelfUpdateQuarantine(packageDir);
	quarantineWindowsNativeDependencies(packageDir);
}

/**
 * 处理 config 命令：启动交互式配置选择器
 *
 * 步骤：
 *   1. 检查 args[0] 是否为 "config"，不是则返回 false（不处理）
 *   2. 创建 SettingsManager 并报告解析错误
 *   3. 创建 DefaultPackageManager 并解析包路径
 *   4. 调用 selectConfig 启动交互式配置 UI
 *   5. 配置完成后 exit(0)
 *
 * 被 main.ts 调用
 * 调用 cli/config-selector.ts 的 selectConfig
 */
export async function handleConfigCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "config") {
		return false;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "config command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolvedPaths = await packageManager.resolve();

	await selectConfig({
		resolvedPaths,
		settingsManager,
		cwd,
		agentDir,
	});

	process.exit(0);
}

/**
 * 处理包管理命令的核心入口函数
 *
 * 命令分发流程：
 *   1. 调用 parsePackageCommand 解析参数，返回 false 表示不处理
 *   2. 按优先级校验错误：help > invalidOption > missingOptionValue > invalidArgument > conflictingOptions > 缺少 source
 *   3. 初始化 SettingsManager、DefaultPackageManager 并设置进度回调
 *   4. 根据 command 分发执行：
 *      - install  → packageManager.installAndPersist(source, { local })
 *      - remove   → packageManager.removeAndPersist(source, { local })
 *      - list     → packageManager.listConfiguredPackages() 并按 user/project 分组输出
 *      - update   → 两阶段：先更新扩展包，再自更新
 *
 * 自更新流程（update 命令中 updateTargetIncludesSelf 为 true 时）：
 *   1. getSelfUpdatePlan(force) → 检查最新版本，决定是否需要更新
 *   2. detectInstallMethod()    → 检测安装方式（npm/pnpm/bun/binary 等）
 *   3. Windows 平台限制：仅 npm/pnpm 支持自更新
 *   4. getSelfUpdateCommand()   → 生成更新命令（返回 null 表示不支持自更新）
 *   5. printSelfUpdateNote()    → 输出更新笔记（如果有）
 *   6. prepareWindowsNpmSelfUpdate() → Windows npm 预处理（隔离原生依赖）
 *   7. runSelfUpdate(command)   → 执行更新命令
 *   8. 异常时 printSelfUpdateFallback() 提示手动更新
 *
 * 被 main.ts 调用
 * 调用 config.ts 的 detectInstallMethod、getSelfUpdateCommand
 * 调用 core/package-manager.ts 的 DefaultPackageManager
 */
export async function handlePackageCommand(args: string[]): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	// 按优先级校验参数错误：help 优先，然后逐项检查各类参数问题
	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	// 初始化配置管理器和包管理器，设置进度回调用于输出安装/更新状态
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "package command");
	const selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand;

	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	// 注册进度回调：安装/更新开始时输出提示信息
	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		// 根据命令类型分发执行
		switch (options.command) {
			case "install":
				// 安装包并持久化到 settings 配置文件
				await packageManager.installAndPersist(source!, { local: options.local });
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				// 移除包并从 settings 配置文件中删除对应条目
				const removed = await packageManager.removeAndPersist(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				// 列出所有已配置的包，按 user（用户级）和 project（项目级）分组显示
				const configuredPackages = packageManager.listConfiguredPackages();
				const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
				const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");

				if (configuredPackages.length === 0) {
					console.log(chalk.dim("No packages installed."));
					return true;
				}

				const formatPackage = (pkg: (typeof configuredPackages)[number]) => {
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					console.log(`  ${display}`);
					if (pkg.installedPath) {
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				};

				if (userPackages.length > 0) {
					console.log(chalk.bold("User packages:"));
					for (const pkg of userPackages) {
						formatPackage(pkg);
					}
				}

				if (projectPackages.length > 0) {
					if (userPackages.length > 0) console.log();
					console.log(chalk.bold("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg);
					}
				}

				return true;
			}

			case "update": {
				// 阶段一：更新扩展包（如果 updateTarget 包含 extensions）
				const target = options.updateTarget ?? { type: "all" };
				if (updateTargetIncludesExtensions(target)) {
					const updateSource = target.type === "extensions" ? target.source : undefined;
					await packageManager.update(updateSource);
					if (updateSource) {
						console.log(chalk.green(`Updated ${updateSource}`));
					} else {
						console.log(chalk.green("Updated packages"));
					}
				}
				// 阶段二：自更新 pi（如果 updateTarget 包含 self）
				if (updateTargetIncludesSelf(target)) {
					// 步骤1：获取自更新计划（检查版本、决定是否需要更新）
					const selfUpdatePlan = await getSelfUpdatePlan(options.force);
					if (!selfUpdatePlan.shouldRun) {
						return true;
					}
					// 步骤2：检测安装方式，Windows 平台仅支持 npm/pnpm 自更新
					const installMethod = detectInstallMethod();
					if (process.platform === "win32" && installMethod !== "npm" && installMethod !== "pnpm") {
						console.error(
							chalk.red(`${APP_NAME} self-update on Windows is only supported for npm and pnpm installs.`),
						);
						console.error(chalk.dim(`Detected install method: ${installMethod}. Update ${APP_NAME} manually.`));
						process.exitCode = 1;
						return true;
					}
					// 步骤3：生成自更新命令（返回 null 表示当前安装方式不支持自动更新）
					const selfUpdateCommand = getSelfUpdateCommand(
						PACKAGE_NAME,
						selfUpdateNpmCommand,
						selfUpdatePlan.packageName,
					);
					if (!selfUpdateCommand) {
						printSelfUpdateUnavailable(selfUpdateNpmCommand, selfUpdatePlan.packageName);
						process.exitCode = 1;
						return true;
					}
					// 步骤4：输出更新笔记（如果有）
					if (selfUpdatePlan.note) {
						printSelfUpdateNote(selfUpdatePlan.note);
					}
					// 步骤5：执行自更新，Windows npm 需先做预处理
					try {
						if (installMethod === "npm") {
							prepareWindowsNpmSelfUpdate();
						}
						await runSelfUpdate(selfUpdateCommand);
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : "Unknown package command error";
						console.error(chalk.red(`Error: ${message}`));
						printSelfUpdateFallback(selfUpdateCommand);
						process.exitCode = 1;
						return true;
					}
					console.log(chalk.green(`Updated ${APP_NAME}`));
				}
				return true;
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
