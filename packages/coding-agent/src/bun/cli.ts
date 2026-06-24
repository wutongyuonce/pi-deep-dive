#!/usr/bin/env node
/**
 * Bun 编译二进制的 CLI 入口文件
 *
 * 【文件定位】
 * 这是 pi coding agent 的 Bun 运行时入口点。当通过 Bun 编译为独立二进制文件后，
 * 系统会直接执行此文件来启动 agent。
 *
 * 【在调用链中的位置】
 * 用户执行 Bun 二进制 → bun/cli.ts → restore-sandbox-env.ts（恢复沙箱环境变量）
 *   → ../cli.ts（主 CLI 入口，解析参数并启动对应运行模式）
 *
 * 【文件职责】
 * 1. 设置进程标题（process.title）为应用名称，便于在进程列表中识别
 * 2. 禁用 Node.js 的 process.emitWarning，避免 Bun 编译环境下出现多余的警告输出
 * 3. 调用 restoreSandboxEnv() 恢复沙箱环境变量（修复 Bun 的已知 bug）
 * 4. 动态导入主 CLI 模块（../cli.ts），启动实际的 agent 逻辑
 *
 * 【为什么使用动态 import】
 * 使用 `await import("../cli.ts")` 而非顶层 import，是为了确保 restoreSandboxEnv()
 * 先于主 CLI 模块执行。主 CLI 模块在初始化时可能读取环境变量（如 API key），
 * 必须先恢复环境变量才能正确初始化。
 */

import { APP_NAME } from "../config.ts";

// 设置进程标题，使其在 `ps`、`top` 等工具中显示为应用名称
process.title = APP_NAME;

// 禁用 Node.js 的 process.emitWarning
// Bun 编译的二进制中，某些 Node.js 内部警告会导致不必要的输出噪音
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

// 在加载主 CLI 之前，先恢复沙箱环境中可能丢失的环境变量
restoreSandboxEnv();

// 动态导入主 CLI 入口，启动 agent 的实际业务逻辑
await import("../cli.ts");
