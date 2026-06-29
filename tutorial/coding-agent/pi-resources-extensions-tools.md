# pi-coding-agent：资源系统、Extension 与工具体系

---

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

## `Extension`：最强、最危险、最像“代码插件”的资源

`src/core/extensions/` 是 `coding-agent` 最厚的扩展面。

### 四个文件的分工

| 文件 | 定位 | 作用 |
| --- | --- | --- |
| `types.ts` | 扩展协议总表 | 定义事件、上下文、工具定义、命令、UI API |
| `loader.ts` | 发现与加载层 | 动态加载 TS/JS extension，创建 runtime stub |
| `runner.ts` | 运行器 | emit 事件、绑定核心行为、管理生命周期 |
| `wrapper.ts` | 桥接层 | 把 extension 注册的工具包装成核心可执行工具 |

这四层可以理解成：

```text
types.ts    定协议
loader.ts   把 extension 代码载入进来
runner.ts   让 extension 真正跑起来
wrapper.ts  让 extension tool 接入核心工具系统
```

### `Extension` 最根本的能力是什么

不是 UI，不是命令，也不是 tool。

真正的根能力是：

> **订阅和干预 `AgentSession` 生命周期里的关键事件。**

例如：

- `tool_call`
- `tool_result`
- `input`
- `context`
- `session_start`
- `session_before_compact`
- `session_before_switch`
- `resources_discover`

这说明 extension 不是简单的“加一个按钮”，而是：

> **在不改核心代码的前提下，参与当前 session 的运行逻辑。**

### 为什么 extension 要和 `AgentSession` 绑定，而不是和 CLI 绑定

因为 extension 真正想扩展的是：

- 当前的 tools
- 当前的 prompt
- 当前的消息流
- 当前的会话树
- 当前的资源发现

这些都属于 `AgentSession` 视角，而不是 CLI 视角。

所以 `bindExtensions()` 放在 `AgentSession` 上，而不是 `main.ts` 上，是非常合理的。

---

## `AgentSession.bindExtensions()`：资源系统和运行时的交汇点

`bindExtensions()` 是一个非常关键的方法，因为它标志着：

> **扩展系统从“已加载”进入“已接入当前会话”。**

这个阶段主要做四件事：

1. 接受 UI / command / abort / shutdown / error 等 bindings
2. 把这些 bindings 应用到当前 `ExtensionRunner`
3. 发出 `session_start` 事件
4. 触发 `resources_discover`，让 extension 追加 skill/prompt/theme 资源

尤其是第 4 点特别重要。

它意味着 extension 不只是“注册行为”，还可以**继续发现资源**。

于是资源流从静态装配扩展成两阶段装配：

```text
阶段 1：ResourceLoader.reload()
  先装全局 / 项目 / package / CLI 资源

阶段 2：AgentSession.bindExtensions()
  extension 通过 resources_discover 动态追加资源
```

这也是为什么 `AgentSession` 要在 bind extension 之后重建 base system prompt。

---

## `skills`：不是代码插件，而是可被模型读取的能力文档

`src/core/skills.ts` 的设计和 extension 完全不同。

它没有执行代码的入口，没有 handler，也没有 runtime context。

它真正做的事情只有两步：

1. 发现 skill 文件
2. 把可见 skill 格式化成 prompt 中的 `<available_skills>`

### 这说明什么

说明 `skill` 的本质不是“给系统新能力”，而是：

> **给模型新的工作指引。**

所以它与 extension 的区别非常根本：

- extension 改的是系统行为
- skill 改的是模型行为

### 为什么 skill 仍然属于资源系统

因为虽然它不执行代码，但它和 extension/prompts/themes 一样，都有：

- 来源发现
- 路径合并
- 冲突处理
- metadata
- system prompt 注入链路

所以它仍然应该由统一的 `ResourceLoader` 管。

---

## `prompts`：轻量级命令化文本模板

`prompt-templates.ts` 在整层架构里常被低估。

它的角色其实很清楚：

> **给用户和 extension 提供一种比 skill 更即时、比 extension 更轻量的“文本能力包”。**

它和 skill 的区别是：

- skill 偏“工作流说明书”
- prompt template 偏“命令化文本片段”

典型用途是：

- `/commit-message`
- `/review`
- `/plan`

这类模板不会像 extension 那样接管生命周期，但会参与 slash command 生态和用户输入扩展。

---

## `themes`：资源系统里最偏 UI 的一类

`themes` 的消费端几乎完全是 interactive mode。

它们说明一件事：

> `ResourceLoader` 不是“只给模型用”的系统，而是“给整个产品运行时用”的系统。

也就是说，同一个资源入口同时服务于：

- 模型侧
  - system prompt
  - skills
  - prompt templates
- UI 侧
  - themes
- 行为侧
  - extensions

这是 `coding-agent` 很产品化的一点。

---

## `AGENTS.md` / `SYSTEM.md`：规则文本不是附属物，而是第一等资源

很多系统会把这些文件视为“额外约定”。

但在 `coding-agent` 里，它们是正式资源：

- `AGENTS.md / CLAUDE.md`
  - 通过 `loadProjectContextFiles()` 被发现
  - 最终进入 `# Project Context`
- `SYSTEM.md`
  - 替换默认 system prompt
- `APPEND_SYSTEM.md`
  - 追加到基础 prompt 之后

这件事的重要性在于：

> 项目规则不是对话外的背景知识，而是运行时要明确注入模型上下文的正式输入。 

---

## 工具系统：资源系统和 agent runtime 的另一个交点

`src/core/tools/` 是第二个关键交点。

### `tools/index.ts` 在做什么

它不是简单的 barrel file，而是工具注册入口：

- 定义 `ToolName`
- 定义 `ToolsOptions`
- 提供 `createToolDefinition()`
- 提供 `createTool()`
- 提供 `createCodingTools()` / `createReadOnlyTools()`
- 提供 `createAllToolDefinitions()`

这说明 `coding-agent` 内部其实维护了两层工具抽象：

1. `ToolDefinition`
   - 结构化定义
   - 带 schema、prompt snippet、guidelines、renderers
2. `AgentTool`
   - 底层 agent runtime 可执行工具

### 为什么要有两层工具抽象

因为 `coding-agent` 的工具不只是“执行一下命令”。

工具还有四层用途：

1. 给模型看
   - `description`
   - `parameters`
   - `promptSnippet`
   - `promptGuidelines`
2. 给 runtime 执行
   - `execute`
3. 给 TUI 渲染
   - `renderCall`
   - `renderResult`
4. 给 extension 包装
   - wrapper / hooks / interception

如果只有 `AgentTool` 这一层，前面 1、3、4 都很难做好。

所以 `ToolDefinition` 才是 `coding-agent` 这一层真正的工具主语。

---

## 为什么 tools 会流入 system prompt

这是 `coding-agent` 工具系统和普通“函数调用系统”最大的不同。

工具定义里不仅有参数 schema，还有：

- `promptSnippet`
- `promptGuidelines`

然后它们会进入 `buildSystemPrompt()`：

- 工具列表
- 使用指南
- active tools 视图

所以对 `coding-agent` 来说，tool system 不是一个孤立执行器，而是：

> **“模型可见能力”与“运行时可执行能力”的统一定义中心。**

这点非常关键，因为它解释了为什么：

- active tools 会影响 prompt
- extension tools 会影响 prompt
- tool allowlist / noTools 会影响 prompt

也就是说，tool registry 改了，不只是执行层改了，**模型看到的世界也改了。**

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
