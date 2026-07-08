# 仓库 script 文件夹下的脚本

按调用方式分类：

## 自动化调用（不是开发者手动执行）

### Git pre-commit 钩子（`git commit` 时自动触发）

通过 `.husky/pre-commit` -> `node scripts/check-lockfile-commit.mjs`

| 脚本                          | 谁调用                   | 何时触发                                                     |
| ----------------------------- | ------------------------ | ------------------------------------------------------------ |
| **check-lockfile-commit.mjs** | Husky 的 pre-commit 钩子 | 每次 `git commit` 时运行。检查 `package-lock.json` 是否被意外暂存，如果有变更且没设环境变量，会阻止提交 |

### npm run check 检查链（`git commit` 时通过 pre-commit 自动运行，也可手动调用）

`npm run check` 是一个命令链，在 `package.json` 中定义：
```json
"check": "biome check --write --error-on-warnings . && npm run check:pinned-deps && npm run check:ts-imports && npm run check:shrinkwrap && tsgo --noEmit && npm run check:browser-smoke"
```

| 脚本                                                     | 谁调用                        | 何时触发                                                     |
| -------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------ |
| **check-pinned-deps.mjs**                                | `npm run check:pinned-deps`   | `git commit` 时自动运行，也可手动 `npm run check:pinned-deps`。确保所有外部依赖用精确版本 |
| **check-ts-relative-imports.mjs**                        | `npm run check:ts-imports`    | `git commit` 时自动运行。禁止 `.ts` 文件中有 `.js` 导入      |
| **generate-coding-agent-shrinkwrap.mjs**                 | `npm run check:shrinkwrap`    | `git commit` 时自动运行（`--check` 模式，只验证不写入），也可 `npm run shrinkwrap:coding-agent` 手动生成 |
| **check-browser-smoke.mjs** + **browser-smoke-entry.ts** | `npm run check:browser-smoke` | `git commit` 时，但**只当修改了 `packages/ai/` 或 `packages/web-ui/` 的文件时才触发** |

## 开发者手动调用的

| 脚本                                     | 命令                                             | 何时使用                                         |
| ---------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| **release.mjs**                          | `npm run release:patch/minor/major`              | **发布时**。开发者运行这个命令来执行完整发布流程 |
| **local-release.mjs**                    | `npm run release:local`                          | **发布前测试**。开发者验证本地打包是否正常工作   |
| **sync-versions.js**                     | 被 `npm run version:patch/minor` 间接调用        | **升级版本时**。统一所有包的版本号               |
| **profile-coding-agent-node.mjs**        | `npm run profile:tui` / `npm run profile:rpc`    | **性能调优时**。开发者分析启动速度               |
| **build-binaries.sh**                    | 被 `release.mjs` 和 `local-release.mjs` 内部调用 | **构建跨平台二进制时**                           |
| **generate-coding-agent-shrinkwrap.mjs** | `npm run shrinkwrap:coding-agent`                | **生成/更新 shrinkwrap 文件时**                  |

## 纯开发者本地分析用的（手动运行）

| 脚本                               | 何时使用                                                     |
| ---------------------------------- | ------------------------------------------------------------ |
| **stats.ts**                       | 开发者想查看项目的 API token 使用量和成本统计                |
| **cost.ts**                        | 开发者想详细查看 API 调用成本                                |
| **tool-stats.ts**                  | 开发者想分析各工具（read/write/bash）的使用频率和 token 消耗 |
| **edit-tool-stats.mjs**            | 开发者分析编辑操作的成功率、膨胀比                           |
| **read-tool-stats.mjs**            | 开发者分析读取操作的模式（全读 vs 部分读取）                 |
| **session-context-stats.mjs**      | 开发者分析上下文窗口使用情况、压缩频率                       |
| **session-transcripts.ts**         | 开发者需要提取会话记录进行分析                               |
| **update-source-imports-to-ts.sh** | 需要批量把 `.js` 导入路径改为 `.ts` 时                       |

---

**简单总结：**
- 大部分检查脚本在 **`git commit` 时自动运行**，保证代码质量
- 发布相关脚本（`release.mjs`、`local-release.mjs`）由**开发者手动执行**
- 分析类脚本（`stats.ts`、`cost.ts` 等）由**开发者在需要时手动调用**