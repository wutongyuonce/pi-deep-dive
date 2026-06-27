# [pi-coding-agent](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent)

整个 pi monorepo 的**产品层 / 运行时编排层**。

如果说：

- `pi-ai` 解决的是"怎么和不同 LLM provider 说话"
- `pi-agent-core` 解决的是"怎么跑一轮 agent loop、怎么调工具、怎么维护消息状态"

那么 `pi-coding-agent` 解决的就是：

> **怎么把统一模型层和通用 agent loop 装配成一个可长期工作、可持久化、可扩展、可交互的 coding agent 产品。**

它对上暴露的是：

- CLI 产品入口 `pi`
- SDK 编程入口 `createAgentSession()` / `createAgentSessionRuntime()`
- 交互模式、print 模式、RPC 模式
- 会话树、压缩、分支、配置、system prompt、extension、skills、tools 这一整套产品机制

它对下负责的是：

- 调 `pi-ai` 找模型、拿认证、发请求、做流式输出
- 调 `pi-agent-core` 驱动 agent loop 和 tool call
- 把会话持久化到 JSONL
- 把 AGENTS.md / SYSTEM.md / skills / extensions / themes / prompts 这些外部资源装进运行时
- 把 TUI、CLI、RPC 这些不同 I/O 外壳接到同一个会话核心上

---

## 一个最小例子

先看最小编程接口，建立直觉：

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();

session.subscribe((event) => {
  if (event.type === "message_update") {
    // 这里可以接自己的 UI
  }
});

await session.prompt("帮我阅读当前项目的入口并解释启动流程");
```

这个例子背后，`pi-coding-agent` 已经替你做了很多产品层工作：

- 选择和恢复 session
- 装载默认工具
- 加载 settings / AGENTS.md / SYSTEM.md / skills / extensions
- 恢复模型与 thinking level
- 组装 system prompt
- 将所有消息和状态写回 session 文件

---

## 整个包的分层图

`packages/coding-agent/src` 可以粗分成六层：

```text
六、产品外壳层
   cli.ts: Node CLI 真正入口，负责进程级初始化后转给 `main.ts`
   main.ts: 启动编排器，负责参数解析、session 选择、runtime 创建、模式分发
   bun/cli.ts: Bun 打包产物对应的入口壳，解决 Bun 环境下的启动适配

五、运行模式层
   modes/interactive/*: 交互式 TUI 壳，包含 `InteractiveMode`、组件、选择器、主题系统
   modes/print-mode.ts: 一次性执行壳，负责把 session 输出成纯文本或 JSON 事件流
   modes/rpc/*: headless RPC 壳，把 `AgentSessionRuntime` 暴露成 JSONL 协议

四、会话运行时层
   core/agent-session-runtime.ts: 当前激活 session 的宿主，负责 `new/resume/fork/import/switch`
   core/agent-session-services.ts: cwd 绑定的基础设施工厂，集中创建 settings、auth、model registry、resource loader
   core/sdk.ts: 会话装配入口，负责把模型、工具、session manager、resource loader 拼成 `AgentSession`
   core/agent-session.ts: 产品核心对象，负责 prompt、持久化、扩展绑定、bash、compaction、tree navigation

三、产品机制层
   core/session-manager.ts: 负责 session tree、JSONL entry 持久化、上下文重建
   core/compaction/*: 负责长对话压缩、branch summary、文件操作摘要和切点计算
   core/settings-manager.ts: 负责全局/项目 settings 加载、深度合并、迁移与持久化
   core/system-prompt.ts: 负责把工具、context files、skills、日期、cwd 拼成最终 system prompt
   core/resource-loader.ts: 负责统一装载 extensions、skills、prompts、themes、AGENTS.md、SYSTEM.md
   core/model-registry.ts model-resolver.ts: 负责 provider/model 可见性、默认模型与 CLI 覆盖解析
   core/prompt-templates.ts: 负责 prompt template 的发现、解析与展开
   core/package-manager.ts: 负责把 settings 中声明的包来源解析成资源路径

二、扩展与工具层
   core/extensions/*: extension 协议、加载器、运行器和桥接层，负责把代码插件接入 session 生命周期
   core/skills.ts: - 负责 skill 发现、frontmatter 解析、冲突处理和 `<available_skills>` 注入
   core/tools/*: 内建工具集合，既定义工具 schema，也实现 read/edit/write/bash/find/grep/ls 等执行逻辑

一、基础支撑层
   utils/*: 各种通用基础设施，比如 shell、路径、图片、剪贴板、HTML 导出、版本检查
   core/event-bus.ts: 提供轻量事件总线，给扩展和运行时传播内部事件
   core/messages.ts: 负责消息内容辅助逻辑和若干消息级工具函数
   core/timings.ts diagnostics.ts: 提供耗时统计和诊断输出，辅助运行时观测
```

可以把它理解成两条横向主线加一条纵向装配链：

- **横向主线 1：运行时主线**
  - `cli.ts -> main.ts -> createAgentSessionRuntime() -> createAgentSession() -> AgentSession -> Interactive/Print/RPC`
- **横向主线 2：资源注入主线**
  - `settings -> package manager -> resource loader -> extensions/skills/prompts/themes -> system prompt -> active tools`
- **纵向装配链**
  - `pi-ai` 提供模型与流式协议
  - `pi-agent-core` 提供 loop 和 tool runtime
  - `pi-coding-agent` 提供持久化、配置、扩展、UI、CLI、模式切换

## 配置文件

* package.json 是一个 JSON 格式的元数据文件，用于描述 JavaScript 项目的基本信息、依赖关系、构建配置和发布规范。它是 npm（Node Package Manager）生态系统的核心组成部分。

  ```json
  {
    "name": "@earendil-works/pi-coding-agent",      // npm 包名，发布到 npm 时用这个名字
    "version": "0.75.5",                            // 当前版本号，遵循 semver（主版本.次版本.补丁）
    "description": "Coding agent CLI with read, bash, edit, write tools and session management",  // 包的简短描述，npm search 时会显示
  
    "type": "module",                               // 使用 ES Modules（import/export）而非 CommonJS（require）
  
    "piConfig": {                                   // pi 自定义字段，非 npm 标准，pi 内部读取来确定项目级配置目录名
      "configDir": ".pi"                            // 项目根目录下的配置文件夹名（如 .pi/settings.json、.pi/AGENTS.md）
    },
  
    "bin": {                                        // npm 全局安装时创建的 CLI 命令
      "pi": "dist/cli.js"                           // 用户敲 `pi` 时执行 dist/cli.js
    },
  
    "main": "./dist/index.js",                      // CommonJS 时代的主要入口，现在被 "exports" 取代，但保留兼容性
    "types": "./dist/index.d.ts",                   // TypeScript 类型声明入口，供导入这个包的项目获得类型提示
  
    "exports": {                                    // Node.js 的现代模块入口映射，控制 `import "xxx"` 时解析到哪个文件
      ".": {                                        // import "@earendil-works/pi-coding-agent" 时
        "types": "./dist/index.d.ts",              //   TypeScript 去哪找类型 index.d.ts
        "import": "./dist/index.js"                //   Node.js 运行时去哪找代码 index.js
      },
      "./hooks": {                                  // import "@earendil-works/pi-coding-agent/hooks" 时（子路径导出）
        "types": "./dist/core/hooks/index.d.ts",   //   类型解析到 hooks/index.d.ts
        "import": "./dist/core/hooks/index.js"     //   运行时解析到 hooks/index.js
      }
    },
  
    "files": [                                      // npm publish 时只包含这些文件/目录到包里
      "dist",                                       //   编译产物
      "docs",                                       //   文档
      "examples",                                   //   示例代码
      "CHANGELOG.md",                               //   变更日志
      "npm-shrinkwrap.json"                         //   锁定依赖版本（发布时用）
    ],
  
    "scripts": {                                    // npm run xxx 执行的脚本
      "clean": "shx rm -rf dist",                   // 清理编译产物（shx 是跨平台的 shell 命令封装）
      "build": "tsgo -p tsconfig.build.json && shx chmod +x dist/cli.js && npm run copy-assets",  // 编译 TS -> JS，给 cli.js 加可执行权限，复制静态资源
      "build:binary": "...",                        // 编译成独立 Bun 二进制文件（用于发布独立可执行程序）
      "copy-assets": "...",                         // 复制主题 JSON、图标 PNG、HTML 模板等静态资源到 dist/
      "copy-binary-assets": "...",                  // Bun 二进制构建时的资源复制（路径不同）
      "test": "vitest --run",                       // 运行测试（vitest，单次运行）
      "shrinkwrap": "node ../../scripts/generate-coding-agent-shrinkwrap.mjs",  // 生成锁文件，固定发布包的依赖版本
      "prepublishOnly": "npm run clean && npm run build && npm run shrinkwrap"  // npm publish 之前自动执行：清理 -> 编译 -> 生成锁文件
    },
  
    "dependencies": {                               // 运行时依赖（用户安装这个包时会自动安装这些）
      "@earendil-works/pi-agent-core": "^0.75.5",   // agent 循环引擎
      "@earendil-works/pi-ai": "^0.75.5",           // AI 模型调用层
      "@earendil-works/pi-tui": "^0.75.5",          // 终端 UI 框架
  	...
    },
  
    "overrides": {                                  // 强制覆盖传递依赖的版本（解决安全漏洞或兼容性问题）
      "rimraf": "6.1.2",
      "gaxios": { "rimraf": "6.1.2" }
    },
  
    "optionalDependencies": {                       // 可选依赖，安装失败不会中断（比如剪贴板功能）
      "@mariozechner/clipboard": "0.3.6"
    },
  
    "devDependencies": {                            // 开发时依赖（不会随包发布）
      "@types/cross-spawn": "6.0.6",                // 类型定义
      "@types/diff": "7.0.2",
      "@types/hosted-git-info": "3.0.5",
      "@types/ms": "2.1.0",
      "@types/node": "24.12.4",
      "@types/proper-lockfile": "4.1.4",
      "shx": "0.4.0",                               // 跨平台 shell 命令（在 scripts 里用）
      "typescript": "5.9.3",                        // TypeScript 编译器
      "vitest": "3.2.4"                             // 测试框架
    },
  
    "keywords": [                                   // npm 搜索关键词
      "coding-agent", "ai", "llm", "cli", "tui", "agent"
    ],
  
    "author": "Mario Zechner",                      // 作者
    "license": "MIT",                               // 开源协议
  
    "repository": {                                 // 源码仓库地址
      "type": "git",
      "url": "git+https://github.com/earendil-works/pi-mono.git",
      "directory": "packages/coding-agent"          // 在 monorepo 中的子目录位置
    },
  
    "engines": {                                    // 要求的 Node.js 最低版本
      "node": ">=22.19.0"
    }
  }
  ```

* npm-shrinkwrap.json - npm 锁定文件，确保依赖版本在所有环境中保持一致。与 package-lock.json 类似，但会被发布到 npm 注册表中。

  自动生成，由 scripts/generate-coding-agent-shrinkwrap.mjs 脚本从根目录的 package-lock.json 提取和转换而来。不要手动编辑。

* tsconfig.build.json - TypeScript 构建配置，用于将 TypeScript 代码编译为 JavaScript。指定了输出目录、根目录和包含/排除的文件。手写。

* tsconfig.examples.json - 示例代码的 TypeScript 配置，专门用于检查 examples/ 目录下的示例文件。配置了路径别名，让示例代码可以直接引用本地源代码而不是编译后的包。手写。

* vitest.config.ts - Vitest 测试框架的配置文件，设置测试环境、超时时间、依赖处理和路径别名。路径别名让测试可以直接引用源代码，便于调试和开发。手写。

## 主调用链

从 `pi` 命令启动到进入交互模式，主调用链路本质上是在**启动一个可切换、可恢复、可扩展的 session runtime**，然后再给这个 runtime 套上 interactive / print / rpc 三种外壳：

`cli.ts -> main.ts -> runtime -> services -> session -> modes`

```ts
cli.ts // coding-agent 的 CLI 入口文件（shebang 脚本）

main.ts
  -> 1、定义 createRuntime 工厂函数
  -> 2、createAgentSessionRuntime(createRuntime, initialOptions) // 把工厂和初始结果装进 runtime
  	-> （1）先调用 createRuntime(initialOptions) 工厂
  	  -> createAgentSessionServices(...) // 先造 services
  	    -> 返回 AgentSessionServices
  	  -> createAgentSessionFromServices(...) // 再基于 services 造 AgentSession
  	    -> 内部委托给 sdk.ts:createAgentSession(...)，得到 AgentSession(...)
  	    -> 返回 { session, extensionsResult, modelFallbackMessage }
  	  -> 工厂返回 { session, services, diagnostics, modelFallbackMessage }
 	-> （2）再 new AgentSessionRuntime(session, services, createRuntime, diagnostics, modelFallbackMessage) // AgentSessionRuntime 持有 session: AgentSession、services: AgentSessionServices，也持有“如何重新创建它们”的 createRuntime 工厂函数
       
interactive / print / rpc 三个 mode 共用同一个会话核心
InteractiveMode runPrintMode runRpcMode
  -> AgentSessionRuntime.session
      -> AgentSession.prompt()
      -> AgentSession.compact()
      -> AgentSession.bindExtensions()
      -> AgentSession.navigateTree()
而 `AgentSession` 内部又会继续调用：
- `sessionManager`
- `settingsManager`
- `resourceLoader`
- `modelRegistry`
- 底层 `agent`

根据参数选择运行模式（interactive / print / rpc）
```

1. 设置进程元数据（标题、环境变量）
1. 配置全局 HTTP 调度器
1. 将控制权交给 `main()` 启动应用

package.json 里的 bin 字段设置

```json
{
  "name": "pi-coding-agent",
  "bin": {
    "pi": "./dist/cli.js"
  }
}
```

npm 读到这个配置后，在 npm install -g 时会自动在全局 bin/ 目录（比如 /usr/local/bin/ ）创建一个符号链接 pi 指向 ./dist/cli.js。当用户敲 pi 时，系统沿着符号链接找到 cli.js ，看到它的 shebang #!/usr/bin/env node，就用 node 来执行它。





```ts
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
// process.env 就像一张"进程信息贴纸"
// 启动时 Shell 已经贴了一些（PATH、HOME、API_KEY...）
// 代码运行时可以再往上贴自己的标签，这里标记当前进程为 coding-agent
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
```

> process 是 Node.js 的**全局对象**，代表当前运行的进程。

四个对象分层：

```
runtime 宿主
  ↓ 持有
services 基础设施
  ↓ 输入给
session 工厂
  ↓ 产出
AgentSession 业务核心
```

核心是  `services -> sdk -> session` 三层：

- `core/agent-session-services.ts` **与 cwd 绑定的环境基础设施集合**
  - 解决的是 **cwd 环境问题**，关心“这轮对话是站在哪个目录里跑”，包含 `createAgentSessionServices()` 函数，以这个目录为中心，向外推导出当前 session 可见的配置、资源、上下文规则和相对路径语义，具体包括：
    - 项目配置环境
      - 这个目录下有没有 .pi/settings.json
    - 上下文规则环境
      - 从这个目录向上找哪些 AGENTS.md / CLAUDE.md
    - 资源发现环境
      - 这个项目下有哪些本地 extensions / skills / prompts / themes
    - 路径解析环境
      - 用户说“读 src/index.ts ”时， src/index.ts 相对谁解析
    - session 归属环境
      - 这个 session 属于哪个项目/子目录视角
  - 负责创建 `authStorage`、`settingsManager`、`modelRegistry`、`resourceLoader` 等
- `core/sdk.ts` **会话装配逻辑**
  - 解决的是**会话装配问题**，包含 `createAgentSession()` 函数，真正把 `pi-ai + pi-agent-core + tools + prompt + session context` 组装成会话的工厂
- `core/agent-session.ts` **产品层真正的核心对象**
  - 解决的是**运行问题**，关心“这轮对话怎么跑”
  - 真正负责 prompt、持久化消息、tool hooks、extension 扩展绑定、compaction、bash、tree navigation

在此基础之上，又包了一层 `core/agent-session-runtime.ts` **当前激活 session 的宿主对象**

- 它不负责“具体一轮 prompt 怎么跑”，而负责“当前宿主现在挂着哪个 session，以及如何切换到另一个 session”

> **如果只有 `sdk.ts -> AgentSession`，其实已经能跑了，那为什么还需要 `AgentSessionRuntime`？**
>
> * `AgentSession` 只负责“这个 session 怎么活”
> * 产品层还要支持：`newSession()`、`switchSession()`、`fork()`、`importFromJsonl()`
>
> * 这些都不是“当前会话内部行为”，而是“当前宿主切到另一个会话”的行为。

例如 `switchSession()` 的流程是：

1. 打开目标 `SessionManager`
2. teardown 当前 session
3. 用同一个 `createRuntime` 工厂重新创建一套新的 `services + session`
4. `apply()` 到 runtime
5. `rebindSession()` 让 UI 或外部宿主重新绑定新 session

`newSession()`、`fork()`、`importFromJsonl()` 也都是同样套路：

- 先准备新的 `SessionManager`
- 再重建一整套 runtime 结果
- 最后替换当前 `session/services`

## 为什么 runtime / services / session 三层拆得这么细

这一点是整层架构最值得强调的设计。

如果不拆，会出现两种坏结果：

### 坏结果 1：一个类承担两种生命周期

- 会话内生命周期
  - prompt
  - tool calls
  - retry
  - compaction
- 宿主生命周期
  - new session
  - resume
  - fork
  - import
  - UI rebind

这两类生命周期天然不同，不该由同一对象同时负责。

### 坏结果 2：cwd 绑定的环境状态和会话状态缠在一起

例如切 session 时，哪些东西要变？

- `cwd`
- `settingsManager`
- `resourceLoader`
- `modelRegistry`
- `systemPrompt`
- 可能的 extension runtime

这些都是环境层的变化，不该和“当前 turn 队列里有哪些消息”放在同一个对象里处理。

所以最终拆成：

```text
宿主层：AgentSessionRuntime
环境层：AgentSessionServices
业务层：AgentSession
```

这是整个启动架构最核心的设计判断。

## 源码地图

### 顶层文件

| 文件 | 定位 | 核心功能 | 主要被谁调用 | 它主要调用谁 |
| --- | --- | --- | --- | --- |
| `src/cli.ts` | CLI 进程入口 | 初始化进程与 HTTP dispatcher，调用 `main()` | npm bin / bun bin | `main.ts` |
| `src/main.ts` | 产品启动编排器 | 解析参数、恢复 session、创建 runtime、分发模式 | `cli.ts`、外部 SDK 也可直接调 `main()` | `cli/*`、`core/*`、`modes/*` |
| `src/index.ts` | 包公共入口 | re-export SDK、tools、extensions、session、modes | 外部 npm 使用者、示例代码 | `core/*`、`modes/*` |
| `src/config.ts` | 路径与版本配置 | `getAgentDir()`、版本、环境路径 | `main.ts`、SDK、工具 | Node path/env |
| `src/migrations.ts` | 数据迁移入口 | session / 配置迁移与弃用告警 | `main.ts` | `SessionManager` 等 |
| `src/package-manager-cli.ts` | 包管理 CLI 子命令 | `package` / `config` 相关命令处理 | `main.ts` | `core/package-manager.ts` |

### `src/cli/`

| 文件 | 定位 | 核心功能 | 主要被谁调用 | 它主要调用谁 |
| --- | --- | --- | --- | --- |
| `args.ts` | 参数协议层 | CLI schema、`parseArgs()`、`printHelp()` | `main.ts` | 无 |
| `file-processor.ts` | `@file` 参数处理 | 将文件文本/图片拼成初始消息 | `main.ts` | `utils/image-*`、`read` 相关逻辑 |
| `initial-message.ts` | 初始消息组装 | 合并 `-p`、stdin、file args | `main.ts` | 无 |
| `list-models.ts` | 列模型命令 | 列出 provider/model | `main.ts` | `ModelRegistry` |
| `session-picker.ts` | session 选择器 | 启动时选择继续哪个会话 | `main.ts` | `SessionManager` |
| `config-selector.ts` | 配置选择器 | 配合 TUI/CLI 选择配置 | `main.ts` | settings 相关模块 |

### `src/core/`

这是整个包最重要的一层。可以再拆成五组：

```text
1. 会话宿主
   agent-session-runtime.ts
   agent-session-services.ts
   sdk.ts
   agent-session.ts

2. 会话与上下文
   session-manager.ts
   compaction/*
   messages.ts

3. 配置与 prompt
   settings-manager.ts
   system-prompt.ts
   prompt-templates.ts

4. 资源与扩展
   resource-loader.ts
   package-manager.ts
   extensions/*
   skills.ts

5. 模型与认证
   auth-storage.ts
   model-registry.ts
   model-resolver.ts
```

其中最值得优先读的 8 个文件是：

| 文件 | 定位 | 为什么重要 |
| --- | --- | --- |
| `core/agent-session.ts` | 产品核心对象 | 几乎所有真正的产品逻辑都在这里汇合 |
| `core/sdk.ts` | SDK 装配入口 | 看懂它就知道会话是怎么被创建出来的 |
| `core/agent-session-runtime.ts` | session 宿主层 | 看懂 `new/resume/fork/import` 怎么落地 |
| `core/agent-session-services.ts` | 基础设施工厂 | 看懂 service 和 session 为什么被拆开 |
| `core/session-manager.ts` | 会话树与 JSONL 持久化 | 看懂 session 为什么不是普通聊天记录 |
| `core/resource-loader.ts` | 外部资源统一入口 | 看懂 extensions/skills/prompts/themes 从哪来 |
| `core/settings-manager.ts` | 分层配置中心 | 看懂全局/项目/目录规则如何叠加 |
| `core/system-prompt.ts` | prompt 装配器 | 看懂模型最终看到什么 |

### `src/modes/`

| 目录 / 文件 | 定位 | 核心功能 | 主要被谁调用 |
| --- | --- | --- | --- |
| `modes/interactive/interactive-mode.ts` | 交互模式总控 | TUI 生命周期、键盘输入、和 `AgentSessionRuntime` 绑定 | `main.ts` |
| `modes/interactive/components/*` | TUI 组件库 | message/tool/bash/tree/footer 等 UI 组件 | `InteractiveMode` |
| `modes/interactive/theme/*` | 主题系统 | 主题 schema、默认深浅色主题、热更新 | `InteractiveMode`、`ResourceLoader` |
| `modes/print-mode.ts` | 单次执行模式 | 非交互运行，支持文本或 JSON 输出 | `main.ts` |
| `modes/rpc/*` | 嵌入式协议层 | 通过 stdin/stdout JSONL 暴露 headless agent | `main.ts`、外部宿主 |

### `src/core/tools/`

`tools/` 是下层 agent loop 能真正"动手"的手臂，但在 `coding-agent` 里，这套工具同时还有两层产品含义：

- 它们是 `system prompt` 的一部分
- 它们会被 extension 再包装、拦截、替换、过滤

| 文件 | 定位 | 核心功能 |
| --- | --- | --- |
| `read.ts` | 文件读取工具 | 偏移读取、截断保护、图片支持 |
| `bash.ts` | Bash 后备工具 | 外部命令执行、流式输出、超时、截断 |
| `edit.ts` | 精确编辑工具 | `oldText -> newText` 精确替换 |
| `edit-diff.ts` | 编辑算法模块 | LF 归一化、fuzzy match、diff 生成 |
| `write.ts` | 文件写入工具 | 新建/覆盖写文件 |
| `grep.ts` | 内容搜索 | ripgrep 后端、结构化搜索 |
| `find.ts` | 文件搜索 | glob/fd 风格路径发现 |
| `ls.ts` | 目录浏览 | 列目录、结果截断 |
| `truncate.ts` | 统一截断策略 | 2000 行 / 50KB 保护 |
| `file-mutation-queue.ts` | 并发安全层 | 同文件写操作串行化 |
| `tool-definition-wrapper.ts` | 双层工具桥 | `ToolDefinition <-> AgentTool` 包装 |
| `index.ts` | 工具注册入口 | 批量创建工具定义/工具实例 |

### `src/core/extensions/`

| 文件 | 定位 | 核心功能 |
| --- | --- | --- |
| `types.ts` | 扩展协议总表 | 事件、上下文、工具定义、命令、UI API |
| `loader.ts` | 发现与加载层 | 加载 TS extension、创建 runtime stub |
| `runner.ts` | 运行器 | emit 各类事件、绑定核心动作、管理生命周期 |
| `wrapper.ts` | 适配层 | 把 extension tool 包成核心可执行工具 |
| `index.ts` | barrel | 对外统一导出 |

### `src/utils/`

这一层不是产品主角，但它解释了很多"为什么 coding-agent 能跑起来"的细节，比如：

- 剪贴板图片读取
- shell 选择与路径规范化
- 图像缩放与 MIME 检测
- changelog/version check
- git 工具与 HTML 导出辅助

它们的特点是：**不决定产品策略，但为上层策略提供机械支撑。**

---

## 最关键的三个中枢

如果只允许你先看三个点，我建议按这个顺序：

### 1. `core/agent-session.ts`

这是全包真正的心脏。

它同时管：

- prompt 进入队列
- agent 事件订阅
- 消息持久化
- tool hook
- 自动压缩
- retry
- bash 执行
- 扩展绑定
- slash command / skill / prompt template / active tools

也就是说，它不是"对 `Agent` 的薄封装"，而是**把 coding-agent 的产品行为真正加上去的地方**。

### 2. `core/session-manager.ts`

这是产品记忆层。

`pi-agent-core` 维护的是当前内存状态；`coding-agent` 之所以能长期工作、可回溯、可分叉、可压缩，是因为这里把会话变成了：

- append-only JSONL
- tree 而不是 list
- 同时容纳 message、model change、thinking change、compaction、branch summary、custom entry

### 3. `core/resource-loader.ts`

这是产品扩展层的统一入口。

如果没有它，`extensions / skills / prompts / themes / AGENTS.md / SYSTEM.md / packages` 都会各自有一套发现逻辑。现在它们被收束为统一装配入口，再被 `system-prompt.ts` 和 `AgentSession` 消费。

---

所以阅读它时，最值得关心的不是某个函数局部怎么写，而是这些问题：

- 哪些对象是"纯运行时"的，哪些是"可持久化"的？
- 哪些机制属于 `Agent`，哪些是 `AgentSession` 额外加上去的？
- 哪些资源在 session 启动前装配，哪些会在运行中动态注入？
- 为什么 extension、skills、tools、prompts 最终都会流入同一个 `system prompt + active tools` 视图？

搞清这几个问题，整个 `coding-agent` 包的结构就不会再散。

缺三块总览性内容：

1. **整包分层图和源码地图**
   - 整个 `packages/coding-agent` 到底有哪些层
   - 每个目录的职责是什么
   - 读源码该先看哪几个入口

2. **启动与运行时装配链**
   - `cli.ts -> main.ts -> runtime -> services -> session -> modes`
   - interactive / print / rpc 三个 mode 如何共用同一个会话核心

3. **资源、扩展、工具三套机制如何汇合**
   - tools 如何进入 prompt
   - extensions 如何绑定到 session
   - skills/prompts/themes/packages 如何通过 resource loader 汇入运行时

这也是本文和后续新增分册要补的部分。

---

## 推荐阅读顺序

如果你的目标是写一份"完整但不失真"的 `pi-coding-agent` 教程，我建议按下面的阅读链组织：

### 第一组：整包骨架

1. 本文 `tutorial/pi-coding-agent.md`
2. `tutorial/coding-agent/pi-startup-runtime-and-modes.md`
3. `tutorial/coding-agent/pi-resources-extensions-tools.md`

### 第二组：会话与上下文主线

4. `tutorial/coding-agent/pi-session-tree.md`
5. `tutorial/coding-agent/pi-compaction.md`

### 第三组：规则与 prompt 主线

6. `tutorial/coding-agent/pi-config-layers.md`
7. `tutorial/coding-agent/pi-system-prompt.md`

### 第四组：外部资源与工具原理补充

8. `tutorial/1/ch15-extensions.md`
9. `tutorial/1/ch16-skills.md`
10. `tutorial/1/ch17-resource-loader.md`
11. `tutorial/1/ch19-tool-principles.md`
12. `tutorial/1/ch20-edit-tool.md`
13. `tutorial/1/ch21-read-tool.md`
14. `tutorial/1/ch22-bash-tool.md`
15. `tutorial/1/ch23-search-tools.md`

换句话说：

- 本文和新增两篇分册，负责**搭骨架**
- `session/config/prompt/compaction` 四篇，负责**讲产品机制**
- 第 15/16/17/19/20/21/22/23 章，负责**给机制补专题级深描**
