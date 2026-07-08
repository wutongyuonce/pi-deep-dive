## `ResourceLoader`：所有外部资源的统一入口

`src/core/resource-loader.ts` 是这一块的总枢纽。

它的公共接口已经非常说明问题：



- `getExtensions()`
- `getSkills()`
- `getPrompts()`
- `getThemes()`
- `getAgentsFiles()`
- `getSystemPrompt()`
- `getAppendSystemPrompt()`
- `extendResources()`
- `reload()`

这说明 `ResourceLoader` 并不是一个"只加载文件"的小工具，而是：

> **在 session 运行前，把所有会影响 agent 行为的外部资源整合成统一视图的装配器。**

### 它统一了哪些来源

资源来源至少有五种：

1. 全局目录 `~/.pi/agent/*`
2. 项目目录 `.pi/*`
3. 目录树上的 `AGENTS.md / CLAUDE.md`
4. settings 里声明的 npm package
5. CLI 临时传入路径
6. extension 在运行时动态发现并追加的资源路径

如果没有 `ResourceLoader`，这些来源会各有一套发现逻辑和覆盖规则。

现在它们被收成了一个统一入口，再向外暴露标准化结果。

### 为什么 `reload()` 是核心

`reload()` 真正做的事不是“重新读几个文件”，而是一次完整的资源重建：

1. 重新加载 settings
2. 让 package manager 解析所有包来源
3. 过滤出启用资源
4. 合并 CLI 额外路径
5. 加载 extensions
6. 检测 extension 冲突
7. 加载 skills / prompts / themes
8. 加载 AGENTS.md / CLAUDE.md
9. 解析 system prompt 与 append prompt

所以 `reload()` 的本质更接近：

> **重建当前 cwd 下的外部资源世界。**

---

## 包管理器不是独立子系统，而是资源系统前置阶段

`src/core/package-manager.ts` 的角色不是“安装 npm 包”这么简单。

它更准确的定位是：

> **把 settings 中声明的包来源，翻译成可被 `ResourceLoader` 消费的路径集合。**

也就是说：

- package manager 负责把包落地、解析目录结构、返回资源路径
- resource loader 负责把这些路径真正装成 extension/skill/prompt/theme

两者关系可以画成：

```text
settings.packages
  ↓
PackageManager.resolve()
  ↓
ResolvedPaths
  ↓
ResourceLoader.reload()
  ↓
extensions / skills / prompts / themes
```

这样拆分以后，包系统和资源系统边界清楚：

- 包系统负责**来源解析**
- 资源系统负责**类型化装配**

---

## 资源类型并不对等

虽然 `ResourceLoader` 对外暴露了统一接口，但不同资源类型的本质很不一样：

| 类型 | 本质 | 最终影响什么 |
| --- | --- | --- |
| `extensions` | 同进程代码模块 | 事件、工具、命令、UI、provider、资源发现 |
| `skills` | Markdown 指令文档 | system prompt 可见技能列表、用户显式 skill 调用 |
| `prompt templates` | 参数化文本模板 | slash command / prompt expansion |
| `themes` | UI 主题 JSON | interactive mode 视觉层 |
| `AGENTS.md` | 目录级规则文本 | project context |
| `SYSTEM.md` | 自定义 system prompt 基础文本 | 整体 system prompt |

统一入口并不意味着它们是同一种资源，只是意味着：

> 它们会在 session 启动前被统一发现，并在运行时由统一宿主持有。

---

## `AgentSession` 怎样消费资源与工具

当资源加载完成后，`AgentSession` 是第一个真正把它们汇合起来的地方。

它主要做三件事：

### 1. 建 runtime tool registry

包括：

- base builtin tools
- custom tools
- extension 注册的 tools

最后形成：

- `_toolRegistry`
- `_toolDefinitions`
- `_toolPromptSnippets`
- `_toolPromptGuidelines`

### 2. 重建 base system prompt

`AgentSession` 会把下面这些东西统一送进 `buildSystemPrompt()`：

- system prompt base text
- append prompt
- context files
- skill 列表
- 当前 active tools 的 snippets/guidelines
- cwd / date

### 3. 在 turn 期间继续允许资源影响 prompt

尤其是 extension 在 `resources_discover` 后追加资源时，会触发：

- `resourceLoader.extendResources(...)`
- 重建 `_baseSystemPrompt`
- 更新 `agent.state.systemPrompt`

这说明 `system prompt` 并不是 session 启动时一次性定死的文本，而是：

> **在当前运行时配置视图下可被重建的派生结果。**

---

## 文件地图：资源与扩展相关目录

### `src/core/` 资源系统相关文件

| 文件 | 定位 | 主要被谁调用 | 它主要调用谁 |
| --- | --- | --- | --- |
| `resource-loader.ts` | 统一资源装配器 | `createAgentSessionServices()`、`AgentSession` | `PackageManager`、`loadExtensions()`、`loadSkills()` |
| `package-manager.ts` | 包来源解析器 | `ResourceLoader` | npm/本地包结构 |
| `prompt-templates.ts` | prompt 模板加载与展开 | `ResourceLoader`、`AgentSession` | 文件系统 |
| `skills.ts` | skill 发现与 prompt 格式化 | `ResourceLoader`、`system-prompt.ts` | frontmatter parser |
| `system-prompt.ts` | prompt 装配器 | `AgentSession` | context files、skills、tool snippets |

### `src/core/extensions/`

| 文件 | 定位 | 主要被谁调用 | 它主要调用谁 |
| --- | --- | --- | --- |
| `types.ts` | 协议层 | 几乎所有 extension 相关代码 | 无 |
| `loader.ts` | 加载层 | `ResourceLoader` | jiti/动态模块、runtime stub |
| `runner.ts` | 运行层 | `AgentSession` | 扩展 handlers |
| `wrapper.ts` | 桥接层 | `AgentSession`、tool 装配逻辑 | 工具定义 |

### `src/core/tools/`

| 文件 | 定位 | 主要被谁调用 | 它主要调用谁 |
| --- | --- | --- | --- |
| `index.ts` | 注册与工厂入口 | `sdk.ts`、`AgentSession`、外部 SDK | 各工具模块 |
| `tool-definition-wrapper.ts` | 双层工具桥 | `sdk.ts`、工具导出 | `ToolDefinition` / `AgentTool` |
| `truncate.ts` | 统一保护层 | read/find/grep/bash/ls | 无 |
| `file-mutation-queue.ts` | 同文件写串行化 | edit/write | Promise queue |
| `read.ts` / `edit.ts` / `write.ts` / `bash.ts` / `grep.ts` / `find.ts` / `ls.ts` | 具体工具 | `tools/index.ts`、`sdk.ts` | 文件系统 / shell / ripgrep 等 |

---

## 这一整套设计得到了什么

### 1. 所有外部能力都有统一装配点

不管是：

- settings
- package
- extension
- skill
- theme
- prompt template
- AGENTS.md
- SYSTEM.md

最后都能回到同一个 `ResourceLoader` / `AgentSession` 视图。

### 2. 模型能力和运行时能力能保持一致

tool 定义同时服务于：

- prompt 中的能力描述
- runtime 中的实际执行

这减少了“模型以为它能用某工具，但运行时其实没有”的错位。

### 3. extension 不只是插件，还能成为资源生产者

通过 `resources_discover`，extension 还能在运行时继续提供 skill/prompt/theme。

这使得生态不是静态的，而是可以二次扩展的。

---

## 也放弃了什么

### 1. 资源系统的心智成本很高

用户需要理解：

- 全局 vs 项目
- settings vs AGENTS.md vs SYSTEM.md
- package vs CLI path
- extension 静态加载 vs 运行时 discover

这显然不是一个简单系统。

### 2. tool / prompt / extension 三者边界不总是直观

同一个需求有时可以用：

- skill 写说明书
- prompt template 写快捷文本
- extension 写代码逻辑

这要求教程必须反复强调三者的边界，否则读者很容易混。

### 3. `system prompt` 变成运行时派生物后，更难“一眼看透”

因为最终 prompt 不再是一个静态文件，而是很多资源拼出来的结果。

但这也是产品能力足够强的代价。

---

## 和已有专题文档的衔接

本篇故意不重复下列专题里的细节：

- `pi-config-layers.md`
  - 更细地讲 settings / AGENTS / SYSTEM 三种规则体系
- `pi-system-prompt.md`
  - 更细地讲 prompt 装配顺序与技能注入
- `tutorial/1/ch15-extensions.md`
  - 更细地讲 extension API 面
- `tutorial/1/ch16-skills.md`
  - 更细地讲 skill 机制与发现算法
- `tutorial/1/ch17-resource-loader.md`
  - 更细地讲 ResourceLoader 实现
- `tutorial/1/ch19-23/*.md`
  - 更细地讲工具设计与各工具实现

本篇只负责把它们统一到一个总视角里：

> `coding-agent` 的资源系统不是“加载一些附属文件”。
> 它实际上是在决定：
> **当前这个 session 到底拥有哪些规则、能力、工具、模板和 UI 外观。**







## AGENTS.md 的拼接规则

`AGENTS.md`（或 `CLAUDE.md`）的规则不同于 settings — 它是**拼接**而非覆盖。

### 目录树上溯发现

`loadProjectContextFiles` 函数从当前工作目录向上搜索，收集路径上所有的 context 文件：

```typescript
// packages/coding-agent/src/core/resource-loader.ts:58-113（简化）

function loadProjectContextFiles(options): Array<{ path; content }> {
  const contextFiles = [];
  const seenPaths = new Set();

  // 1. 先加载全局 context（~/.pi/agent/AGENTS.md 或 CLAUDE.md）
  const globalContext = loadContextFileFromDir(resolvedAgentDir);
  if (globalContext) {
    contextFiles.push(globalContext);
    seenPaths.add(globalContext.path);
  }

  // 2. 从 cwd 向上遍历到根目录
  const ancestorContextFiles = [];
  let currentDir = resolvedCwd;
  while (true) {
    const contextFile = loadContextFileFromDir(currentDir);
    if (contextFile && !seenPaths.has(contextFile.path)) {
      ancestorContextFiles.unshift(contextFile); // 最远的在前
      seenPaths.add(contextFile.path);
    }
    if (currentDir === root) break;
    currentDir = resolve(currentDir, "..");
  }

  // 3. 全局在前，祖先目录从远到近排列
  contextFiles.push(...ancestorContextFiles);
  return contextFiles;
}
```

`loadContextFileFromDir` 在每个目录中依次查找 `AGENTS.md` 和 `CLAUDE.md`，找到第一个就返回。这意味着如果同一个目录同时有 `AGENTS.md` 和 `CLAUDE.md`，只有 `AGENTS.md` 会被加载（它在候选列表中排第一）。

```typescript
// packages/coding-agent/src/core/resource-loader.ts:58-74

function loadContextFileFromDir(dir: string) {
  const candidates = ["AGENTS.md", "CLAUDE.md"];
  for (const filename of candidates) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      return { path: filePath, content: readFileSync(filePath, "utf-8") };
    }
  }
  return null;
}
```

最终的拼接顺序：

```
1. ~/.pi/agent/AGENTS.md         ← 全局规则（最先注入）
2. /AGENTS.md                    ← 根目录（如果有）
3. /project/AGENTS.md            ← 项目根目录
4. /project/packages/AGENTS.md   ← 子目录
5. /project/packages/legacy/AGENTS.md  ← 当前工作目录
```

三者**同时生效**，后者可以补充或细化前者的规则。这些文件最终被注入到 system prompt 的 `# Project Context` 区域（见第 14 章）。

### SYSTEM.md 的替换规则

`SYSTEM.md` 的规则又不同 — 它是**替换**而非拼接：

```
如果项目 .pi/SYSTEM.md 存在 → 替换默认 system prompt
否则如果全局 SYSTEM.md 存在 → 替换默认 system prompt
否则 → 使用默认 system prompt
```

```typescript
// packages/coding-agent/src/core/resource-loader.ts:834-846

private discoverSystemPromptFile(): string | undefined {
  const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
  if (existsSync(projectPath)) return projectPath;
  const globalPath = join(this.agentDir, "SYSTEM.md");
  if (existsSync(globalPath)) return globalPath;
  return undefined;
}
```

pi 还支持 `APPEND_SYSTEM.md` — 一个追加到 system prompt 末尾的文件，发现逻辑与 SYSTEM.md 相同（项目优先于全局）。这让用户可以在不替换默认 prompt 的情况下追加内容。

为什么 AGENTS.md 拼接而 SYSTEM.md 替换？

因为它们的语义不同。AGENTS.md 是"额外的规则" — 目录级规则不应该消灭全局规则，而是在全局规则的基础上添加新的约束。SYSTEM.md 是"完全自定义的 system prompt" — 如果用户要自定义 system prompt，通常是想完全控制 prompt 的内容，而不是在默认 prompt 后面追加一段。

