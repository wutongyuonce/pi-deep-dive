/**
 * Node.js 运行环境下的入口聚合文件。
 *
 * 定位：
 * - 在默认 `index.ts` 的基础上，额外暴露 Node 专属执行环境 `NodeExecutionEnv`
 * - 供 CLI、服务端或需要访问本地文件系统 / 进程能力的集成方使用
 *
 * 谁会 import 我：
 * - 需要 `NodeExecutionEnv` 的宿主程序
 * - 既想拿到通用 agent 导出、又想拿到 Node 环境适配层的调用方
 *
 * 我在整个体系中的作用：
 * - 把运行时相关导出和通用 agent API 放到同一个入口
 * - 避免调用方分别记忆 `harness/env/nodejs.ts` 与 `index.ts` 的内部路径
 */
export { NodeExecutionEnv } from "./harness/env/nodejs.ts";
export * from "./index.ts";
