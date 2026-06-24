#!/usr/bin/env node
/**
 * coding-agent 的 CLI 入口文件（shebang 脚本）。
 *
 * 定位：
 * - 这是整个 coding-agent 命令行工具的最顶层入口
 * - 它是一个轻量的引导层（bootstrap），只做三件事：
 *   1. 设置进程元数据（标题、环境变量）
 *   2. 配置全局 HTTP 调度器
 *   3. 将控制权交给 `main()` 启动应用
 *
 * 在调用链中的角色：
 *   cli.ts → main.ts（main 函数）→ 根据参数选择运行模式（interactive / print / rpc）
 *
 * 阅读建议：
 * - 想理解"应用如何启动"：看完这个文件后，直接去看 `main.ts`
 * - 想理解各运行模式：看 `modes/` 目录下的 interactive / print / rpc 模块
 * - 想理解会话层和 SDK：看 `core/agent-session.ts` 和 `core/sdk.ts`
 */

// ── import ──────────────────────────────────────────────────────────
// 应用名称常量，用于设置进程标题和窗口标识
import { APP_NAME } from "./config.ts";
// 配置 undici 全局 HTTP 调度器，统一管理所有出站 HTTP 请求的行为（超时、重试等）
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
// 应用主函数，负责解析参数并启动对应的运行模式
import { main } from "./main.ts";

// ── 进程设置 ────────────────────────────────────────────────────────
// 设置进程标题，使其在 `ps` / `top` 等工具中显示为应用名称而非 "node"
process.title = APP_NAME;
// 标记当前进程为 coding-agent，供其他模块识别运行上下文
process.env.PI_CODING_AGENT = "true";
// 禁用 Node.js 的 process.emitWarning，避免在运行过程中输出无关的警告信息干扰用户
process.emitWarning = (() => {}) as typeof process.emitWarning;

// ── 配置 HTTP 调度器 ────────────────────────────────────────────────
// 在任何 provider SDK 发起请求之前，配置 undici 的全局 HTTP 调度器。
// 运行时的详细设置（如代理、超时）会在 SettingsManager 加载全局/项目配置后应用。
configureHttpDispatcher();

// ── 启动应用 ────────────────────────────────────────────────────────
// 将命令行参数（去掉前两个元素：node 和脚本路径）传入 main 函数，
// 由 main.ts 根据参数决定进入哪种运行模式（交互模式 / 打印模式 / RPC 模式）。
main(process.argv.slice(2));
