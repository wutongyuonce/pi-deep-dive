/**
 * 扩展加载器
 *
 * 作用/定位：负责发现、加载、初始化扩展模块。
 * 提供：运行时创建、扩展 API 构造、模块加载（jiti）、目录发现。
 *
 * 调用链路：
 *   discoverAndLoadExtensions()
 *     → discoverExtensionsInDir() — 从目录中发现扩展文件
 *     → loadExtensions()          — 批量加载扩展
 *       → loadExtension()         — 加载单个扩展
 *         → loadExtensionModule() — 用 jiti 动态导入 TS 模块
 *         → createExtension()     — 创建空 Extension 对象
 *         → createExtensionAPI()  — 为扩展构造 API 接口
 *         → factory(api)          — 调用扩展工厂函数完成初始化
 *   loadExtensionFromFactory()  — 从内联工厂函数创建扩展（不走文件加载）
 *   createExtensionRuntime()    — 创建共享运行时（初始为 stub，后由 runner.bindCore() 替换）
 *
 * 被谁调用：session-manager.ts 初始化时、交互模式启动时、/reload 命令触发时。
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as _bundledPiAgentCore from "@earendil-works/pi-agent-core";
import * as _bundledPiAi from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import * as _bundledPiTui from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";
// 静态导入扩展可能使用的包。
// 必须使用静态导入，这样 Bun 才会将它们打包到编译后的二进制文件中。
// 然后通过 virtualModules 选项将它们提供给扩展使用。
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary } from "../../config.ts";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @earendil-works/pi-coding-agent.
// 注意：此处导入可行，因为 loader.ts 的导出不会从 index.ts 再次导出，从而避免循环依赖。
// 扩展可以通过 @earendil-works/pi-coding-agent 导入这些内容。
import * as _bundledPiCodingAgent from "../../index.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import type {
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.ts";

/** 扩展可用的虚拟模块映射（用于编译后的 Bun 二进制文件） */
const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: _bundledTypebox,
	"typebox/compile": _bundledTypeboxCompile,
	"typebox/value": _bundledTypeboxValue,
	"@sinclair/typebox": _bundledTypebox,
	"@sinclair/typebox/compile": _bundledTypeboxCompile,
	"@sinclair/typebox/value": _bundledTypeboxValue,
	"@earendil-works/pi-agent-core": _bundledPiAgentCore,
	"@earendil-works/pi-tui": _bundledPiTui,
	"@earendil-works/pi-ai": _bundledPiAi,
	"@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": _bundledPiAgentCore,
	"@mariozechner/pi-tui": _bundledPiTui,
	"@mariozechner/pi-ai": _bundledPiAi,
	"@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};

const require = createRequire(import.meta.url);

/**
 * 获取 jiti 的模块别名（用于 Node.js/开发模式）。
 * 在 Bun 二进制模式下使用 virtualModules 替代。
 */
let _aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	const piCodingAgentEntry = packageIndex;
	const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@earendil-works/pi-agent-core");
	const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@earendil-works/pi-tui");
	const piAiEntry = resolveWorkspaceOrImport("ai/dist/index.js", "@earendil-works/pi-ai");

	_aliases = {
		"@earendil-works/pi-coding-agent": piCodingAgentEntry,
		"@earendil-works/pi-agent-core": piAgentCoreEntry,
		"@earendil-works/pi-tui": piTuiEntry,
		"@earendil-works/pi-ai": piAiEntry,
		"@mariozechner/pi-coding-agent": piCodingAgentEntry,
		"@mariozechner/pi-agent-core": piAgentCoreEntry,
		"@mariozechner/pi-tui": piTuiEntry,
		"@mariozechner/pi-ai": piAiEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	return _aliases;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * 创建扩展运行时，包含抛出异常的桩方法。
 * Runner.bindCore() 会将这些桩方法替换为真实实现。
 *
 * 作用：在扩展加载阶段，所有操作方法都抛出 "not initialized" 错误，
 * 防止扩展在加载期间误调用操作。加载完成后由 runner.bindCore() 替换为真实实现。
 *
 * 运行时还管理：flag 值、provider 注册队列、过期检查（assertActive/invalidate）。
 *
 * 实现步骤：
 * 1. 创建 notInitialized 函数（抛出未初始化错误）
 * 2. 创建 assertActive 函数（检查过期状态）
 * 3. 构建 ExtensionRuntime 对象，所有操作方法初始为 notInitialized
 * 4. registerProvider 在绑定前将请求加入队列，unregisterProvider 从队列中移除
 *
 * 被谁调用：loadExtensions()、loadExtensionFromFactory()
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string } = {};
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() 在扩展加载期间即有效；refreshTools 仅在 bindCore 之后才需要生效。
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		assertActive,
		invalidate: (message) => {
			state.staleMessage ??=
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
		},
		// 绑定前：排队注册请求，待 bindCore() 获取到 model registry 后再批量刷新。
		// bindCore() 会将这些桩方法替换为直接调用。
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
		},
	};

	return runtime;
}

/**
 * 为扩展创建 ExtensionAPI 对象，提供给扩展工厂函数。
 *
 * 实现逻辑：
 * - 注册方法（on/registerTool/registerCommand 等）直接写入 Extension 对象
 * - 操作方法（sendMessage/exec/setModel 等）委托给共享 runtime
 * - 每次调用前通过 runtime.assertActive() 检查扩展实例是否已过期
 *
 * @param extension - 目标扩展对象，注册数据存储在此
 * @param runtime   - 共享运行时，操作方法的实现
 * @param cwd       - 当前工作目录，用于 exec() 等操作
 * @param eventBus  - 事件总线，供扩展间通信
 *
 * 被谁调用：loadExtension()、loadExtensionFromFactory()
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	const api = {
		// 注册方法 - 写入扩展对象
		on(event: string, handler: HandlerFn): void {
			runtime.assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			runtime.assertActive();
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			runtime.assertActive();
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.ts").ExtensionContext) => Promise<void> | void;
			},
		): void {
			runtime.assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			runtime.assertActive();
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			runtime.assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		// Flag 访问 - 检查扩展是否注册了该 flag，从运行时读取值
		getFlag(name: string): boolean | string | undefined {
			runtime.assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.get(name);
		},

		// 操作方法 - 委托给共享运行时
		sendMessage(message, options): void {
			runtime.assertActive();
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			runtime.assertActive();
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			runtime.assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			runtime.assertActive();
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			runtime.assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			runtime.assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			runtime.assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			runtime.assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			runtime.assertActive();
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			runtime.assertActive();
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			runtime.assertActive();
			return runtime.getCommands();
		},

		setModel(model) {
			runtime.assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			runtime.assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			runtime.assertActive();
			runtime.setThinkingLevel(level);
		},

		registerProvider(name: string, config: ProviderConfig) {
			runtime.assertActive();
			runtime.registerProvider(name, config, extension.path);
		},

		unregisterProvider(name: string) {
			runtime.assertActive();
			runtime.unregisterProvider(name, extension.path);
		},

		events: eventBus,
	} as ExtensionAPI;

	return api;
}

/**
 * 使用 jiti 动态加载扩展模块并获取工厂函数。
 *
 * 实现逻辑：
 * 1. 创建 jiti 实例（Bun 二进制模式使用 virtualModules，Node 使用 alias）
 * 2. 动态导入扩展模块
 * 3. 返回默认导出作为工厂函数（非函数返回 undefined）
 *
 * 被谁调用：loadExtension()
 */
async function loadExtensionModule(extensionPath: string) {
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		// In Bun binary: use virtualModules for bundled packages (no filesystem resolution)
		// Also disable tryNative so jiti handles ALL imports (not just the entry point)
		// In Node.js/dev: use aliases to resolve to node_modules paths
			// Bun 二进制模式：使用 virtualModules 提供打包的包（不走文件系统解析）
		// 同时禁用 tryNative，让 jiti 处理所有导入（不仅仅是入口点）
		// Node.js/开发模式：使用别名解析到 node_modules 路径
		...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	return typeof factory !== "function" ? undefined : factory;
}

/**
 * 创建一个空的 Extension 对象，包含所有空集合（handlers、tools、commands 等）。
 *
 * 被谁调用：loadExtension()、loadExtensionFromFactory()
 * 内部逻辑：根据路径判断来源（local 或 temporary），创建 sourceInfo，
 *           初始化所有 Map 集合用于后续注册。
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

/**
 * 加载单个扩展模块。
 *
 * 实现步骤：
 * 1. 解析扩展文件路径
 * 2. 动态加载模块获取工厂函数
 * 3. 创建 Extension 对象
 * 4. 创建 ExtensionAPI
 * 5. 调用工厂函数完成初始化
 *
 * 被谁调用：loadExtensions()
 */
async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const factory = await loadExtensionModule(resolvedPath);
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = createExtension(extensionPath, resolvedPath);
		const api = createExtensionAPI(extension, runtime, cwd, eventBus);
		await factory(api);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * 从内联工厂函数创建 Extension（不经过文件加载流程）。
 * 用于测试或内置扩展等场景。
 *
 * 调用链路：createExtension() → createExtensionAPI() → factory(api)
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const extension = createExtension(extensionPath, extensionPath);
	const resolvedCwd = resolvePath(cwd);
	const api = createExtensionAPI(extension, runtime, resolvedCwd, eventBus);
	await factory(api);
	return extension;
}

/**
 * 从给定路径列表批量加载扩展。
 *
 * 被谁调用：discoverAndLoadExtensions()、session-manager 初始化
 * 内部逻辑：创建共享 runtime，遍历路径逐个加载，收集错误
 */
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedCwd = resolvePath(cwd);
	const resolvedEventBus = eventBus ?? createEventBus();
	const runtime = createExtensionRuntime();

	for (const extPath of paths) {
		const { extension, error } = await loadExtension(extPath, resolvedCwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
	};
}

/** 从 package.json 读取 pi 清单字段的内容类型。 */
interface PiManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
	prompts?: string[];
}

/**
 * 从 package.json 文件中读取 pi 清单（"pi" 字段）。
 * 解析失败时返回 null。
 *
 * 被谁调用：resolveExtensionEntries()
 */
function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const content = fs.readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content);
		if (pkg.pi && typeof pkg.pi === "object") {
			return pkg.pi as PiManifest;
		}
		return null;
	} catch {
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * 从目录中解析扩展入口点。
 *
 * 解析规则（按优先级）：
 * 1. package.json 中包含 "pi.extensions" 字段 → 返回声明的路径列表
 * 2. 存在 index.ts 或 index.js → 返回该索引文件
 *
 * 返回解析后的路径数组，如果未找到入口点则返回 null。
 */
function resolveExtensionEntries(dir: string): string[] | null {
	// Check for package.json with "pi" field first
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * 从目录中发现扩展文件。
 *
 * 发现规则：
 * 1. 直接文件：extensions/*.ts 或 *.js → 加载
 * 2. 含 index 的子目录：extensions/*/index.ts 或 index.js → 加载
 * 3. 含 package.json 的子目录：extensions/*/package.json 包含 "pi" 字段 → 加载其声明的内容
 *
 * 不递归超过一层。复杂包必须使用 package.json 清单。
 *
 * 被谁调用：discoverAndLoadExtensions()
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * 从标准位置发现并加载扩展。
 *
 * 发现顺序（去重）：
 * 1. 项目本地扩展：cwd/.pi/extensions/
 * 2. 全局扩展：agentDir/extensions/
 * 3. 用户显式配置的路径
 *
 * 调用链路：discoverExtensionsInDir() → loadExtensions()
 * 被谁调用：session-manager 初始化、交互模式启动、/reload 命令
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/
	const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
	addPaths(discoverExtensionsInDir(localExtDir));

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(resolvedAgentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with pi manifest or index.ts
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}

	return loadExtensions(allPaths, resolvedCwd, eventBus);
}
