/**
 * 一次性迁移模块 —— 在应用启动时运行，负责将旧版本遗留的数据和目录结构
 * 迁移到当前版本要求的格式与位置。
 *
 * ## 迁移策略
 * - 所有迁移均为幂等操作：首次运行完成迁移，后续运行检测到已完成则直接跳过。
 * - 迁移过程中任何错误都会被静默捕获，不会阻塞应用启动。
 * - 对已废弃但尚未清理的目录，仅发出警告，不会自动删除用户数据。
 *
 * ## 迁移项总览
 * 1. **认证数据迁移**：oauth.json + settings.json 中的 apiKeys → auth.json
 * 2. **会话文件位置修正**：~/.pi/agent/*.jsonl → sessions/<encoded-cwd>/
 * 3. **命令目录迁移**：commands/ → prompts/
 * 4. **键绑定配置迁移**：将旧版 keybindings.json 格式升级为新版
 * 5. **工具二进制迁移**：tools/ → bin/
 * 6. **废弃目录检测**：检测 hooks/ 和 tools/ 等废弃目录并发出警告
 *
 * ## 调用方式
 * 由 main.ts 中的 `runMigrations(cwd)` 统一调度，返回迁移结果与废弃警告。
 */

import chalk from "chalk";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir, getBinDir } from "./config.ts";
import { migrateKeybindingsConfig } from "./core/keybindings.ts";

// 废弃扩展的迁移指南链接
const MIGRATION_GUIDE_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
// 扩展系统文档链接
const EXTENSIONS_DOC_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md";

/**
 * 将旧版认证数据迁移到统一的 auth.json 文件。
 *
 * ## 迁移场景
 * 旧版本中，OAuth 凭据存储在 oauth.json，API Key 存储在 settings.json 的 apiKeys 字段中。
 * 新版本将两者统一合并到 auth.json，每个 provider 条目包含 type 字段标识认证类型。
 *
 * ## 内部步骤
 * 1. 若 auth.json 已存在，说明已完成迁移，直接返回空数组。
 * 2. 读取 oauth.json，将每个 provider 的凭据标记为 type: "oauth" 后写入合并结果，
 *    然后将原文件重命名为 oauth.json.migrated。
 * 3. 读取 settings.json 的 apiKeys 字段，将未被 oauth 覆盖的 provider 标记为 type: "api_key"，
 *    并从 settings.json 中删除 apiKeys 字段。
 * 4. 将合并结果写入 auth.json（权限 0o600，仅所有者可读写）。
 *
 * @returns 已迁移的 provider 名称列表
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// auth.json 已存在则跳过迁移
	if (existsSync(authPath)) return [];

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];

	// 步骤 1：迁移 oauth.json 中的 OAuth 凭据
	if (existsSync(oauthPath)) {
		try {
			const oauth = JSON.parse(readFileSync(oauthPath, "utf-8"));
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			// 重命名而非删除，便于用户回溯
			renameSync(oauthPath, `${oauthPath}.migrated`);
		} catch {
			// 解析或读取失败时静默跳过，不阻塞启动
		}
	}

	// 步骤 2：迁移 settings.json 中的 apiKeys 字段
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					// 仅迁移未被 OAuth 覆盖且值为字符串的条目
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				// 从 settings.json 中移除 apiKeys 字段，避免残留敏感数据
				delete settings.apiKeys;
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			}
		} catch {
			// 解析或读取失败时静默跳过
		}
	}

	// 步骤 3：将合并结果写入 auth.json
	if (Object.keys(migrated).length > 0) {
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileSync(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
	}

	return providers;
}

/**
 * 将误放在 agent 根目录下的会话文件迁移到正确的子目录。
 *
 * ## 迁移场景
 * v0.30.0 中存在一个 Bug：会话文件被保存到了 ~/.pi/agent/ 目录下，
 * 而非正确的 ~/.pi/agent/sessions/<encoded-cwd>/ 目录。
 * 本函数检测这些散落的 .jsonl 文件，并根据其会话头中的 cwd 字段
 * 将它们移动到对应的正确目录。
 *
 * ## 内部步骤
 * 1. 扫描 agentDir 下的顶层 .jsonl 文件（排除子目录中的文件）。
 * 2. 读取每个文件的第一行（会话头），解析 JSON 获取 type 和 cwd 字段。
 * 3. 使用与 session-manager.ts 相同的路径编码算法，将 cwd 转换为 safePath 目录名。
 * 4. 创建目标目录（如不存在），将文件移动过去。
 * 5. 若目标文件已存在则跳过，避免覆盖。
 *
 * @see https://github.com/earendil-works/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// 扫描 agentDir 下的顶层 .jsonl 文件（不递归进入子目录）
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		// 目录不存在或无法读取时直接返回
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// 读取第一行作为会话头，提取 cwd 信息
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			// 必须是类型为 "session" 且包含 cwd 的有效会话头
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// 使用与 session-manager.ts 一致的路径编码算法：
			// 去掉前导分隔符，将所有分隔符和冒号替换为 "-"，前后加 "--"
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			// 创建目标目录
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// 提取文件名并构建目标路径
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			// 目标文件已存在则跳过，避免覆盖
			if (existsSync(newPath)) continue;

			renameSync(file, newPath);
		} catch {
			// 单个文件迁移失败时静默跳过，不影响其他文件
		}
	}
}

/**
 * 将指定目录下的 commands/ 子目录重命名为 prompts/。
 * 同时支持普通目录和符号链接。
 *
 * @param baseDir - 父目录路径（全局 agent 目录或项目目录）
 * @param label - 用于日志输出的标签（如 "Global" 或 "Project"）
 * @returns 是否成功完成迁移
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	// 仅当 commands/ 存在且 prompts/ 不存在时执行迁移
	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

/**
 * 迁移键绑定配置文件 keybindings.json。
 *
 * 读取 agent 目录下的 keybindings.json，调用 core/keybindings.ts 中的
 * migrateKeybindingsConfig 进行格式升级（如重命名旧键名、补全缺失字段等）。
 * 若文件不存在或内容非合法对象则跳过。
 */
function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		// 仅处理非空的普通对象，忽略数组和其他类型
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		// 委托给 core/keybindings.ts 执行实际的格式迁移
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		// 迁移成功后回写文件
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// 文件格式异常时静默忽略，不影响启动
	}
}

/**
 * 将 tools/ 目录下的 fd/rg 二进制文件迁移到 bin/ 目录。
 *
 * ## 迁移场景
 * 旧版本将 fd 和 rg 搜索工具的二进制文件放在 tools/ 目录下，
 * 新版本改为统一存放在 bin/ 目录。本函数将这些二进制移动到新位置。
 *
 * ## 内部步骤
 * 1. 若 tools/ 目录不存在则跳过。
 * 2. 遍历 fd、rg 及其 Windows 版本（fd.exe、rg.exe）。
 * 3. 若旧文件存在且新位置无同名文件，则移动；若新位置已有同名文件，则仅删除旧文件。
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	// 需要迁移的二进制文件列表（含 Windows 可执行文件后缀）
	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				// 新位置无同名文件，执行移动
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// 移动失败时静默跳过
				}
			} else {
				// 新位置已有同名文件，仅删除旧文件
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// 删除失败时静默忽略
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * 检测指定目录下是否存在已废弃的 hooks/ 和 tools/ 目录，并生成警告信息。
 *
 * ## 检测逻辑
 * - hooks/ 目录：已更名为 extensions/，若存在则提示迁移。
 * - tools/ 目录：其中的 fd/rg 二进制由系统自动提取，不属于用户自定义工具，
 *   因此仅当 tools/ 中存在除 fd/rg 和隐藏文件之外的自定义内容时才发出警告。
 *
 * @param baseDir - 父目录路径（全局 agent 目录或项目目录）
 * @param label - 用于警告信息的标签（如 "Global" 或 "Project"）
 * @returns 警告信息数组
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	// hooks/ 目录已更名为 extensions/
	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	// tools/ 可能包含系统自动提取的 fd/rg 二进制，仅对自定义工具发出警告
	if (existsSync(toolsDir)) {
		try {
			const entries = readdirSync(toolsDir);
			// 过滤掉 fd/rg 二进制和隐藏文件（如 .DS_Store）
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // 忽略 .DS_Store 等隐藏文件
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// 目录读取失败时静默忽略
		}
	}

	return warnings;
}

/**
 * 执行扩展系统相关迁移并收集废弃目录警告。
 *
 * ## 执行内容
 * 1. 全局目录（agentDir）和项目目录（projectDir）的 commands/ → prompts/ 迁移。
 * 2. 检测全局和项目目录下废弃的 hooks/ 和 tools/ 目录。
 *
 * @param cwd - 当前工作目录，用于定位项目级配置目录
 * @returns 废弃目录警告信息数组
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// 迁移全局和项目级的 commands/ → prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// 收集全局和项目级的废弃目录警告
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * 将废弃目录警告输出到控制台，并等待用户按键确认后继续。
 *
 * ## 交互流程
 * 1. 若无警告信息则直接返回。
 * 2. 逐条输出黄色警告信息。
 * 3. 输出迁移指南和扩展文档链接。
 * 4. 提示用户按下任意键继续，然后将 stdin 切换到原始模式等待按键。
 * 5. 用户按键后恢复 stdin 的正常模式，程序继续执行。
 *
 * @param warnings - 警告信息数组
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	// 逐条输出警告
	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	// 等待用户按键确认
	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * 执行所有一次性迁移。由 main.ts 在应用启动时调用一次。
 *
 * ## 调用顺序与依赖关系
 * 1. `migrateAuthToAuthJson()` - 认证数据迁移，返回已迁移的 provider 列表
 * 2. `migrateSessionsFromAgentRoot()` - 会话文件位置修正
 * 3. `migrateToolsToBin()` - 工具二进制迁移（tools/ → bin/）
 * 4. `migrateKeybindingsConfigFile()` - 键绑定配置格式升级
 * 5. `migrateExtensionSystem(cwd)` - 扩展系统迁移（commands/ → prompts/）及废弃目录检测
 *
 * 各迁移项之间无严格依赖，按上述顺序依次执行。
 * 返回的 deprecationWarnings 需由调用方通过 showDeprecationWarnings() 展示给用户。
 *
 * @param cwd - 当前工作目录
 * @returns migratedAuthProviders: 已迁移的认证 provider 列表；deprecationWarnings: 废弃目录警告
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
