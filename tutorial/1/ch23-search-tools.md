# 第 23 章：`find` 和 `grep` — 结构化搜索替代万能 bash

> **定位**：本章解析 find 和 grep 从 bash 中独立出来的设计理由。
> 前置依赖：第 19 章（工具设计原则）、第 22 章（bash 的定位）。
> 适用场景：当你想理解为什么"多一个工具"有时比"少一个工具"更好。

## 为什么要把搜索从 bash 中拆出来？

LLM 用 bash 搜索时的典型模式：

```bash
# LLM 可能会生成
find . -name "*.ts" -not -path "node_modules/*" | head -100
grep -rn "registerProvider" --include="*.ts" src/
```

这些命令有几个问题：

1. **平台不一致**。macOS 的 `find` 和 Linux 的 `find` 参数不完全相同
2. **node_modules 陷阱**。LLM 经常忘记排除 `node_modules`，导致返回几万个结果
3. **结果截断不可控**。`head -100` 是 LLM 的猜测，不是系统的保护

pi 把搜索拆成两个结构化工具 — find（按文件名搜索）和 grep（按内容搜索） — 每个都有明确的参数定义、自动保护和跨平台一致性。

## 两个 Schema 对比

把 find 和 grep 的 schema 放在一起看，可以清楚地看到它们各自的职责边界：

```typescript
// packages/coding-agent/src/core/tools/find.ts:20-26
const findSchema = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files, " +
      "e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"
  }),
  path: Type.Optional(Type.String({
    description: "Directory to search in (default: cwd)"
  })),
  limit: Type.Optional(Type.Number({
    description: "Maximum number of results (default: 1000)"
  })),
});
```

```typescript
// packages/coding-agent/src/core/tools/grep.ts:23-35
const grepSchema = Type.Object({
  pattern: Type.String({
    description: "Search pattern (regex or literal string)"
  }),
  path: Type.Optional(Type.String({
    description: "Directory or file to search (default: cwd)"
  })),
  glob: Type.Optional(Type.String({
    description: "Filter files by glob pattern, e.g. '*.ts'"
  })),
  ignoreCase: Type.Optional(Type.Boolean({
    description: "Case-insensitive search (default: false)"
  })),
  literal: Type.Optional(Type.Boolean({
    description: "Treat pattern as literal string (default: false)"
  })),
  context: Type.Optional(Type.Number({
    description: "Lines before and after each match (default: 0)"
  })),
  limit: Type.Optional(Type.Number({
    description: "Maximum number of matches (default: 100)"
  })),
});
```

find 有 3 个参数，grep 有 7 个 — 这个差异反映了内容搜索比文件名搜索本质上更复杂。grep 需要控制正则/字面量模式、大小写敏感、上下文行数、文件类型过滤，这些在 bash `grep` 命令中是通过 `-i`、`-F`、`-C`、`--include` 等 flags 实现的。结构化 schema 把这些 flags 转化为有描述的命名参数，让 LLM 不需要记忆 flag 字母。

## 默认限制的设计

```typescript
// packages/coding-agent/src/core/tools/find.ts:30
const DEFAULT_LIMIT = 1000;

// packages/coding-agent/src/core/tools/grep.ts:38
const DEFAULT_LIMIT = 100;
```

find 默认 1000 条，grep 默认 100 条。这个 10 倍的差异有意为之：

- **文件名列表的信息密度低**。每条结果就是一个路径，一千条路径在 LLM context 中占用不大。LLM 经常需要浏览大量文件来理解项目结构。
- **内容搜索的信息密度高**。每条 grep 结果包含文件路径、行号、匹配行内容、可能还有上下文行。100 条 grep 结果已经提供了足够的信息，更多只会浪费 context。

LLM 可以通过 `limit` 参数覆盖默认值，但大多数情况下默认值足够好。这种"合理的默认值"减少了 LLM 需要做的决策数量。

## `.gitignore` 集成

两个搜索工具都自动尊重 `.gitignore` 规则。这不是一个 flag — 它是默认行为，不能关闭。

为什么强制启用？因为 LLM 搜索 `node_modules`、`dist`、`.git` 这些目录的结果几乎从来都不是有用的。一个典型的 Node.js 项目，`node_modules` 中的文件数量可能是源码的 100 倍。不排除这些目录，搜索结果会被噪声淹没。

find 工具的实现优先使用 `fd`（如果系统安装了的话），否则回退到 Node.js 的 `globSync`：

```typescript
// packages/coding-agent/src/core/tools/find.ts:41-46
export interface FindOperations {
  exists: (absolutePath: string) =>
    Promise<boolean> | boolean;
  glob: (
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number }
  ) => Promise<string[]> | string[];
}
```

`fd` 是一个 Rust 写的 `find` 替代品，默认尊重 `.gitignore`、速度极快。当 `fd` 可用时，find 工具通过 `ensureTool` 确保它已安装，然后使用 `spawnSync` 调用。这是一个"能力增强"的设计 — 核心功能不依赖外部工具，但安装了外部工具后性能更好。

## ripgrep 后端

grep 工具的后端是 ripgrep（`rg`）。选择 ripgrep 而非系统 `grep` 的原因：

1. **默认尊重 `.gitignore`**。和 `fd` 一样，不需要额外配置
2. **速度**。ripgrep 使用 Rust 的 regex crate，在大代码库上比 GNU grep 快数倍
3. **Unicode 安全**。正确处理 UTF-8 文件，不会因为二进制文件内容导致乱码输出
4. **单行截断**。ripgrep 可以限制匹配行的最大长度，避免一行 minified JS 消耗大量 context

```typescript
// packages/coding-agent/src/core/tools/truncate.ts:13
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line
```

每条 grep 匹配行被截断到 500 字符。这个限制处理了一个常见的噪声源 — minified 文件中的匹配。一行 50KB 的 minified JavaScript 如果包含搜索词，不加截断就会消耗大量 context 而不提供有用信息。

## 结果截断的层次

grep 的截断有三个层次，形成递进的保护：

**1. 单行截断**（500 字符）— 防止单个匹配行过长
**2. 匹配数限制**（默认 100 条）— 防止匹配结果过多
**3. 总输出截断**（50KB）— 最终的安全网

```typescript
// packages/coding-agent/src/core/tools/grep.ts:40-44
export interface GrepToolDetails {
  truncation?: TruncationResult;
  matchLimitReached?: number;
  linesTruncated?: boolean;
}
```

`matchLimitReached` 记录了是否因为 limit 而停止搜索。当这个字段有值时，返回给 LLM 的结果会附带提示："搜索在第 N 条结果后停止，可能还有更多匹配。如果需要更多，请增加 limit 参数或缩小搜索范围。"

`linesTruncated` 标记是否有匹配行被截断。这让 LLM 知道某些匹配行的内容不完整，如果需要完整行可以用 read 工具去读对应文件。

## `GrepOperations` 的可插拔设计

```typescript
// packages/coding-agent/src/core/tools/grep.ts:50-55
export interface GrepOperations {
  isDirectory: (absolutePath: string) =>
    Promise<boolean> | boolean;
  readFile: (absolutePath: string) =>
    Promise<string> | string;
}
```

grep 的 operations 接口比 find 的更简单 — 只需要判断路径类型和读取文件。这是因为 grep 的核心搜索逻辑（ripgrep 调用）在默认实现中处理，远程场景下可能需要完全不同的搜索策略（比如全文搜索引擎而非逐文件 grep）。

find 和 grep 的 operations 接口都支持同步和异步返回值（`Promise<T> | T`）。这种灵活性让本地实现可以用同步文件系统调用（更快，无 event loop 开销），远程实现可以用异步调用。

## TUI 中的搜索结果展示

find 结果在 TUI 中按文件路径显示，每条结果一行，超过 10 条后折叠。grep 结果的展示更复杂 — 包含文件路径（作为分组标题）、行号（高亮显示）、匹配行内容（搜索词高亮）。

两个工具的 TUI 展示都使用了和 read 相同的"默认折叠 + 手动展开"模式。LLM 看到的是完整的截断后结果，用户在 TUI 中看到的是精简预览。

## 取舍分析

### 得到了什么

**大幅降低搜索出错率**。LLM 不需要拼 shell 命令、不需要记住平台差异、不需要手动排除 node_modules。

**分层截断保护**。从单行截断到匹配数限制到总输出截断，三层保护确保搜索结果永远不会消耗失控的 context。

**性能提升**。ripgrep 和 fd 在大代码库上比系统工具快数倍，这直接转化为 agent 的响应速度提升。

### 放弃了什么

**多了两个工具增加选择负担**。LLM 需要知道"搜文件名用 find、搜内容用 grep、其他用 bash"。system prompt 中的工具使用指引帮助 LLM 做选择，但对于不熟悉 pi 工具集的 LLM（比如较弱的模型），额外的工具可能导致混淆。

**强制 .gitignore 过滤可能遗漏需要的文件**。如果 LLM 需要搜索 `dist/` 目录中的构建产物，find 和 grep 都会跳过它。这时 LLM 必须回退到 bash 工具。

---

### 版本演化说明
> 本章核心分析基于 pi-mono v0.66.0。find 和 grep 是较晚从 bash 中分离出来的工具。
> 它们的 `Operations` 接口（和 edit、bash 一样的 pluggable 设计）允许远程执行。
> `GREP_MAX_LINE_LENGTH` 的 500 字符限制是在实际使用中根据 minified 文件的噪声问题调整的。
