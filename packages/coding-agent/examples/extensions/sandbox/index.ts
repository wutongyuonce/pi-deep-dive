/**
 * Sandbox 扩展示例：为 bash 命令接入操作系统级沙箱。
 *
 * 文件定位：
 * - `pi-coding-agent` 扩展示例目录中的安全扩展
 * - 展示如何覆盖内置 `bash` 工具，并把命令执行接到 OS-level sandbox 上
 *
 * 核心职责：
 * - 读取并合并全局 / 项目级沙箱配置
 * - 在 session 启动时初始化 `@anthropic-ai/sandbox-runtime`
 * - 覆盖默认 `bash` 工具，使 bash 命令在沙箱中运行
 * - 提供 `/sandbox` 命令查看当前生效配置
 *
 * 工作方式：
 * - macOS 下依赖系统级沙箱能力
 * - Linux 下依赖 bubblewrap 等工具
 * - 本文件本身不直接实现内核级隔离，而是通过 `SandboxManager` 包装命令
 *
 * 配置文件（两层合并，项目配置优先级更高）：
 * - `~/.pi/agent/extensions/sandbox.json`
 * - `<cwd>/.pi/sandbox.json`
 *
 * 示例 `.pi/sandbox.json`：
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * 使用方式：
 * - `pi -e ./sandbox`：按默认值和配置文件启用沙箱
 * - `pi -e ./sandbox --no-sandbox`：通过 CLI 显式关闭沙箱
 * - `/sandbox`：查看当前沙箱配置
 *
 * 安装方式：
 * 1. 将 `sandbox/` 目录复制到 `~/.pi/agent/extensions/`
 * 2. 在该目录中执行 `npm install`
 *
 * Linux 额外依赖：
 * - `bubblewrap`
 * - `socat`
 * - `ripgrep`
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BashOperations, createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";

/** 扩展自身使用的沙箱配置：在运行时配置基础上补一个启用开关。 */
interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
}

/** 默认沙箱策略：不给配置文件时就使用这一套。 */
const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

/**
 * 加载并合并沙箱配置。
 *
 * 定位：
 * - 扩展内部的配置装载入口
 * - 为 `session_start` 和 `/sandbox` 命令提供统一配置来源
 *
 * 合并顺序：
 * - 默认配置
 * - 用户级配置 `~/.pi/agent/extensions/sandbox.json`
 * - 项目级配置 `<cwd>/.pi/sandbox.json`
 *
 * @param cwd 当前会话工作目录
 * @returns 合并后的最终沙箱配置
 */
function loadConfig(cwd: string): SandboxConfig {
	const projectConfigPath = join(cwd, ".pi", "sandbox.json");
	const globalConfigPath = join(getAgentDir(), "extensions", "sandbox.json");

	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};

	// 先读用户级配置。解析失败只告警，不阻断扩展启动。
	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	// 再读项目级配置。项目配置优先级高于用户级配置。
	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	// 按“默认 -> 全局 -> 项目”的顺序叠加，得到当前 session 的最终策略。
	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

/**
 * 合并两份沙箱配置。
 *
 * 定位：
 * - 模块内部的配置合并辅助函数
 * - 负责把默认值、全局配置和项目配置逐层叠加
 *
 * 说明：
 * - 这里只做浅层对象合并，不会对数组做拼接
 * - `network` / `filesystem` 分组整体覆盖各自字段
 * - 对扩展字段做单独处理，避免被 `SandboxRuntimeConfig` 类型遗漏
 *
 * @param base 基础配置
 * @param overrides 覆盖配置
 * @returns 合并后的新配置对象
 */
function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };

	// 顶层开关单独覆盖。
	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;

	// 网络和文件系统配置按分组做浅合并，便于局部覆盖。
	if (overrides.network) {
		result.network = { ...base.network, ...overrides.network };
	}
	if (overrides.filesystem) {
		result.filesystem = { ...base.filesystem, ...overrides.filesystem };
	}

	// 某些运行时扩展字段不在基础类型声明里，这里显式接住并传递下去。
	const extOverrides = overrides as {
		ignoreViolations?: Record<string, string[]>;
		enableWeakerNestedSandbox?: boolean;
	};
	const extResult = result as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };

	if (extOverrides.ignoreViolations) {
		extResult.ignoreViolations = extOverrides.ignoreViolations;
	}
	if (extOverrides.enableWeakerNestedSandbox !== undefined) {
		extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
	}

	return result;
}

/**
 * 创建“带沙箱”的 bash 执行后端。
 *
 * 定位：
 * - `createBashTool()` 所需 `operations` 的构造器
 * - 将默认 bash 执行路径替换为“先包沙箱，再 spawn bash”
 *
 * 说明：
 * - 这里并不直接解析命令语义，而是调用 `SandboxManager.wrapWithSandbox()`
 *   生成被沙箱包装后的 shell 命令
 * - 真正执行仍然由系统 `bash -c` 完成
 *
 * @returns 可交给 `createBashTool()` 的 `BashOperations`
 */
function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			// 先确认工作目录存在，避免在无效 cwd 中启动子进程。
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			// 让 sandbox runtime 生成带隔离策略的包装命令。
			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				// 通过 `bash -c` 执行包装后的命令，并单独接管 stdout/stderr。
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				// 若调用方设置了超时，则在超时后直接杀掉整个进程组。
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}

				// 把子进程输出转发给外层 UI / 流式更新逻辑。
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				// 启动失败或运行时错误直接向上抛出。
				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				// 外层主动取消时，同样杀掉整个进程组，避免子进程残留。
				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				// 进程结束后统一归并三类状态：abort / timeout / 正常退出。
				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) {
						reject(new Error("aborted"));
					} else if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
					} else {
						resolve({ exitCode: code });
					}
				});
			});
		},
	};
}

/**
 * 扩展主入口。
 *
 * 定位：
 * - `pi` 扩展加载后执行的注册函数
 * - 在这里声明 flag、覆盖工具、挂接 session 生命周期和命令
 *
 * 被谁调用：
 * - 扩展加载器在发现该扩展后调用默认导出函数
 *
 * @param pi 扩展 API
 */
export default function (pi: ExtensionAPI) {
	// 提供一个 CLI 开关，允许用户显式跳过沙箱。
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	// 先保留一份原始 bash 工具，方便在沙箱关闭时回退到默认行为。
	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	// 这两个状态位分别表示“配置上启用”与“运行时已成功初始化”。
	let sandboxEnabled = false;
	let sandboxInitialized = false;

	// 覆盖内置 bash 工具：启用沙箱时改走包装执行，否则退回原始 bash。
	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxEnabled || !sandboxInitialized) {
				return localBash.execute(id, params, signal, onUpdate);
			}

			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	// 用户直接触发 bash 时，也把底层操作实现替换成沙箱版本。
	pi.on("user_bash", () => {
		if (!sandboxEnabled || !sandboxInitialized) return;
		return { operations: createSandboxedBashOps() };
	});

	// session 启动时决定本次会话是否启用沙箱，并完成底层 runtime 初始化。
	pi.on("session_start", async (_event, ctx) => {
		const noSandbox = pi.getFlag("no-sandbox") as boolean;

		// CLI 显式关闭优先级最高。
		if (noSandbox) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		// 读取当前工作目录对应的最终配置。
		const config = loadConfig(ctx.cwd);

		// 配置文件也可以整体关闭沙箱。
		if (!config.enabled) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via config", "info");
			return;
		}

		// 只在受支持的平台上尝试初始化底层沙箱。
		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
			return;
		}

		try {
			// 某些扩展字段当前未直接暴露在基础配置类型中，这里做一次显式提取。
			const configExt = config as unknown as {
				ignoreViolations?: Record<string, string[]>;
				enableWeakerNestedSandbox?: boolean;
			};

			// 初始化底层 sandbox runtime，后续 wrapWithSandbox 才能正常工作。
			await SandboxManager.initialize({
				network: config.network,
				filesystem: config.filesystem,
				ignoreViolations: configExt.ignoreViolations,
				enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
			});

			sandboxEnabled = true;
			sandboxInitialized = true;

			// 在状态栏展示当前策略规模，方便用户快速确认限制是否生效。
			const networkCount = config.network?.allowedDomains?.length ?? 0;
			const writeCount = config.filesystem?.allowWrite?.length ?? 0;
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`),
			);
			ctx.ui.notify("Sandbox initialized", "info");
		} catch (err) {
			// 初始化失败时回退到未启用状态，并提示用户失败原因。
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	});

	// session 结束时重置 sandbox runtime，避免把状态泄漏到后续会话。
	pi.on("session_shutdown", async () => {
		if (sandboxInitialized) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	// 提供一个交互命令，方便查看当前生效的沙箱规则。
	pi.registerCommand("sandbox", {
		description: "Show sandbox configuration",
		handler: async (_args, ctx) => {
			if (!sandboxEnabled) {
				ctx.ui.notify("Sandbox is disabled", "info");
				return;
			}

			const config = loadConfig(ctx.cwd);
			const lines = [
				"Sandbox Configuration:",
				"",
				"Network:",
				`  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
				`  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
				"",
				"Filesystem:",
				`  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
				`  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
				`  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
