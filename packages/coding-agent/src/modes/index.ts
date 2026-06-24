/**
 * 运行模式桶导出文件（barrel export）
 *
 * 文件定位：`modes/` 目录的公共 API 入口，聚合导出所有运行模式的核心类型与函数。
 *
 * 在调用链中的位置：
 * - 被 `../main.ts` 导入，根据 CLI 参数选择对应的运行模式（interactive / print / rpc）
 * - 被 `../index.ts`（包的顶层入口）再次转发导出，供外部 SDK 使用
 *
 * 提供的能力：
 * - InteractiveMode / InteractiveModeOptions -- 交互式模式（TUI 全屏对话）
 * - runPrintMode / PrintModeOptions          -- 打印模式（单次执行，`pi -p "prompt"`）
 * - RpcClient / RpcClientOptions / RpcMode   -- RPC 模式（JSON-RPC 通信）
 * - ModelInfo / RpcEventListener 等辅助类型
 *
 * 与其他文件的关系：
 * - 各导出项的具体实现分别位于 `interactive/interactive-mode.ts`、`print-mode.ts`、`rpc/rpc-client.ts`、`rpc/rpc-mode.ts`、`rpc/rpc-types.ts`
 * - 本文件仅做重导出，不包含任何业务逻辑
 */

export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.ts";
export { runRpcMode } from "./rpc/rpc-mode.ts";
export type { RpcCommand, RpcResponse, RpcSessionState } from "./rpc/rpc-types.ts";
