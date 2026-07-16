/**
 * OAuth 能力的兼容导出入口。
 *
 * 文件定位：
 * - 这是一个极简 re-export 文件
 * - 目的是把真正的 OAuth 实现集中从 `utils/oauth/index.ts` 暴露出来，
 *   方便外部通过稳定入口导入
 */

export * from "./utils/oauth/index.ts";
