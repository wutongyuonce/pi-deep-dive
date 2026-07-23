# 仓库 `scripts/` 文件夹下的脚本

按调用方式分类：

## 自动化调用（不是开发者手动执行）

### Git pre-commit 钩子（`git commit` 时自动触发）

最新版仓库通过 `.husky/pre-commit` 串起以下检查：

1. `node scripts/check-lockfile-commit.mjs`
2. `npm run check`
3. 如果暂存文件命中了 `packages/ai/*`、`packages/web-ui/*`、`package.json`、`package-lock.json`，再额外执行一次 `npm run check:browser-smoke`
4. 将被格式化修改过的已暂存文件重新 `git add`

| 脚本 | 谁调用 | 何时触发 |
| --- | --- | --- |
| **check-lockfile-commit.mjs** | Husky 的 pre-commit 钩子 | 每次 `git commit` 时先运行。检查 `package-lock.json` 是否被意外暂存；若检测到锁文件变更且未显式允许，会直接阻止提交 |

### `npm run check` 检查链（可手动运行，也会被 pre-commit 调用）

最新版根目录 `package.json` 中的 `check` 命令：

```json
"check": "biome check --write --error-on-warnings . && npm run check:pinned-deps && npm run check:ts-imports && npm run check:shrinkwrap && npm run check:install-lock:coding-agent && tsgo --noEmit && npm run check:browser-smoke"
```

| 脚本 | 谁调用 | 何时触发 |
| --- | --- | --- |
| **check-pinned-deps.mjs** | `npm run check:pinned-deps` | `npm run check` 链中执行，也可手动调用。确保外部依赖保持精确版本 |
| **check-ts-relative-imports.mjs** | `npm run check:ts-imports` | `npm run check` 链中执行。检查 TypeScript 相对导入的写法是否符合仓库约束 |
| **generate-coding-agent-shrinkwrap.mjs** | `npm run check:shrinkwrap` | `npm run check` 链中以 `--check` 模式执行，只验证 `packages/coding-agent/npm-shrinkwrap.json` 是否需要更新 |
| **generate-coding-agent-install-lock.mjs** | `npm run check:install-lock:coding-agent` | `npm run check` 链中以 `--check` 模式执行，只验证 `packages/coding-agent/install-lock/package-lock.json` 是否需要更新 |
| **check-browser-smoke.mjs** + **browser-smoke-entry.ts** | `npm run check:browser-smoke` | `npm run check` 链中执行，也可能被 pre-commit 额外单独触发。用 esbuild 打包浏览器入口，验证浏览器侧最小可用性 |

## 开发者手动调用的

| 脚本 | 命令 | 何时使用 |
| --- | --- | --- |
| **release.mjs** | `npm run release:patch` / `npm run release:minor` / `npm run release:major` | 正式发布时执行完整发布流程：升版本、更新 changelog、生成发布产物、跑检查和测试、提交、打 tag、推送 |
| **publish.mjs** | `npm run publish` / `npm run publish:dry` | 手动发布 npm 包时使用。先校验各包是否已构建、是否已发布，再逐个 `npm publish`；`--dry-run` 只做验证不真正发布 |
| **local-release.mjs** | `npm run release:local` | 发布前本地演练。生成 tarball，并在仓库外构造隔离安装目录做 smoke test |
| **release-notes.mjs** | `npm run release:fix-links` | 处理 GitHub Release 文本。既能从 changelog 提取某个版本的发布说明，也能修复历史 release notes 中的仓库链接 |
| **sync-versions.js** | 被 `npm run version:patch/minor/major` 间接调用 | 升版本时统一工作区中各 package 的版本号 |
| **profile-coding-agent-node.mjs** | `npm run profile:tui` / `npm run profile:rpc` | 性能调优时分析 coding-agent 在不同模式下的启动性能 |
| **build-binaries.sh** | 被 `local-release.mjs` 内部调用，也可单独运行 | 构建当前平台或指定平台的二进制发布产物 |
| **generate-coding-agent-shrinkwrap.mjs** | `npm run shrinkwrap:coding-agent` | 生成或更新 `packages/coding-agent/npm-shrinkwrap.json` |
| **generate-coding-agent-install-lock.mjs** | `npm run install-lock:coding-agent` | 生成或更新 `packages/coding-agent/install-lock/package-lock.json`，为 install 场景提供受控锁文件 |

## 纯开发者本地分析 / 排障用的（手动运行）

| 脚本 | 何时使用 |
| --- | --- |
| **stats.ts** | 查看项目的 API token 使用量和成本统计 |
| **cost.ts** | 细看 API 调用成本 |
| **tool-stats.ts** | 分析各工具（read/write/bash 等）的使用频率和 token 消耗 |
| **edit-tool-stats.mjs** | 分析编辑操作的成功率、膨胀比等指标 |
| **read-tool-stats.mjs** | 分析读取操作的模式（全读 / 部分读取） |
| **session-context-stats.mjs** | 分析上下文窗口使用情况和压缩频率 |
| **session-transcripts.ts** | 提取会话记录做后续分析 |
| **update-source-imports-to-ts.sh** | 批量把源码中的 `.js` 导入路径改成 `.ts` |
| **repro-5893-wsl-bash.mjs** | 在 Windows + WSL Bash 环境下复现并验证 issue #5893 的 bash 变量展开问题 |

---

## 简单总结

- **提交时自动跑的**：`check-lockfile-commit.mjs`，以及 `npm run check` 链里的检查脚本
- **发布/版本管理相关**：`release.mjs`、`publish.mjs`、`local-release.mjs`、`release-notes.mjs`、`sync-versions.js`
- **构建锁文件与发布产物相关**：`generate-coding-agent-shrinkwrap.mjs`、`generate-coding-agent-install-lock.mjs`、`build-binaries.sh`
- **分析 / 排障类**：`stats.ts`、`cost.ts`、`tool-stats.ts`、`repro-5893-wsl-bash.mjs` 等
