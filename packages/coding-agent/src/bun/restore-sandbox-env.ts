/**
 * 沙箱环境变量恢复工具
 *
 * 【背景问题】
 * Bun 编译的二进制文件在沙箱环境（如 Linux/macOS 上的 nono）中运行时，
 * process.env 会为空对象。这是一个已知的 Bun bug：
 * https://github.com/oven-sh/bun/issues/27802
 *
 * 【文件定位】
 * 此文件是 bun/cli.ts 启动流程中的第一个修复步骤。
 * 在主 CLI 模块加载之前执行，确保环境变量可用。
 *
 * 【调用链路】
 * bun/cli.ts → restoreSandboxEnv() → ../cli.ts（需要环境变量如 API key）
 *
 * 【解决方案】
 * 在 Linux 上，从 /proc/self/environ 读取原始环境变量并恢复到 process.env。
 * macOS 上 /proc/self/environ 不可用，此修复仅对 Linux 沙箱有效。
 */

import { readFileSync } from "node:fs";

/**
 * 从 /proc/self/environ 恢复环境变量到 process.env
 *
 * 【触发条件】
 * 仅在以下两个条件同时满足时执行恢复：
 * 1. 当前运行时是 Bun（process.versions.bun 存在）
 * 2. process.env 为空（Object.keys(process.env).length === 0）
 *
 * 【执行步骤】
 * 1. 检查是否为 Bun 运行时，非 Bun 环境直接返回
 * 2. 检查 process.env 是否已有条目，有则说明无需修复
 * 3. 读取 /proc/self/environ 文件（Linux 特有的 procfs 接口）
 *    - 该文件包含所有环境变量，以 null 字节（\0）分隔
 *    - 每个条目格式为 KEY=VALUE
 * 4. 按 \0 分割后逐条解析，将 KEY=VALUE 写入 process.env
 * 5. 如果读取失败（文件不存在或无权限），静默忽略错误
 *
 * 【被谁调用】
 * bun/cli.ts 在加载主 CLI 模块之前调用此函数
 *
 * 【返回值】
 * void - 无返回值，通过副作用修改 process.env
 */
export function restoreSandboxEnv(): void {
	// 步骤1：非 Bun 运行时不需要此修复
	if (!process.versions?.bun) return;

	// 步骤2：如果 process.env 已有条目，说明环境正常，无需修复
	if (Object.keys(process.env).length > 0) return;

	try {
		// 步骤3：从 /proc/self/environ 读取原始环境变量
		// 该文件由 Linux 内核提供，包含进程启动时的所有环境变量
		// 格式：KEY1=VALUE1\0KEY2=VALUE2\0...
		const data = readFileSync("/proc/self/environ", "utf-8");

		// 步骤4：按 null 字节分割，逐条解析并恢复
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				// 将 KEY=VALUE 格式的条目写入 process.env
				process.env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
	} catch {
		// 步骤5：/proc/self/environ 可能不可读（非 Linux 或权限不足），静默忽略
	}
}
