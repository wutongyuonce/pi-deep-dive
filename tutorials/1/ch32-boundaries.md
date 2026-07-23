# 第 32 章：这套架构的适用边界

> **定位**：本章帮助读者判断 pi 的架构适不适合自己的场景。
> 前置依赖：第 30-31 章（设计哲学）。
> 适用场景：当你在评估是否基于 pi 构建产品。

## 适合什么

**1. 需要深度定制的 agent 产品**。如果你的产品和"通用聊天机器人"差别很大 — 比如一个特定领域的 coding assistant、一个基于 Slack 的运维 bot、一个带自定义 UI 的内部工具 — pi 的分层架构让你可以只替换需要的层，保留其余。

**2. 重视工程纪律的团队**。pi 的架构要求开发者理解分层边界、事件流契约、回调语义。这对工程能力有门槛，但回报是系统的可预测性和可维护性。

**3. 需要支持多 LLM 厂商的场景**。pi-ai 层的 provider 抽象让切换和混用 LLM 成为一行代码的事。如果你的产品需要同时支持 Claude、GPT、Gemini、自部署模型，pi 的统一调用面省去了大量适配工作。

**4. 需要多产品形态的场景**。如果你的 agent 需要同时运行在终端、Slack、Web、API 等多个入口，pi 的协议式内核让你只写一次循环逻辑，每个入口只实现自己的"壳"。mom 就是最好的证明（第 28 章）。

## 不适合什么

**1. 需要开箱即用的简单 chatbot**。如果你只想快速上线一个"问答机器人"，Vercel AI SDK 或 LangChain 更合适。pi 的价值在定制化，不在快速启动。一个简单的 chatbot 用 pi 的架构相当于"杀鸡用牛刀"。

**2. 需要复杂的多 agent 编排**。如果你的场景是"10 个 agent 协作完成一个任务"，pi 的单 agent 循环模型需要你自己在上层搭建编排层。专注于 multi-agent 的框架（如 CrewAI、AutoGen）可能更直接。虽然 pi 可以用 tool call 组合子 agent（第 31 章），但这不等于"原生多 agent 编排"。

**3. 非 TypeScript/Node.js 技术栈**。pi 是 TypeScript 项目，运行在 Node.js 上。如果你的团队主力是 Python 或 Go，使用 pi 意味着引入额外的技术栈。这不仅是语言问题 — 还涉及包管理（npm）、运行时（Node.js）、类型系统（TypeScript）的学习成本。

**4. 需要极低延迟的嵌入式场景**。pi 的分层架构在每次 LLM 调用时经历 transformContext → convertToLlm → stream → 事件分发 的完整管道。对于延迟敏感的实时场景（如语音助手），这些层次可能引入不必要的开销。

## 团队评估清单

在决定是否采用 pi 之前，回答以下五个问题：

### Q1：你的 agent 需要运行在几种产品形态中？

- **1 种**（只有 CLI 或只有 Web）→ pi 的多产品适应性对你没有价值。考虑更垂直的方案。
- **2-3 种**（CLI + Web、CLI + Slack 等）→ pi 的分层架构开始有回报。内核复用能省大量重复代码。
- **4+ 种** → pi 的设计正是为这种场景优化的。

### Q2：你需要支持几个 LLM provider？

- **1 个**（只用 Claude 或只用 GPT）→ 直接调用厂商 SDK 更简单。pi-ai 的 provider 抽象是多此一举。
- **2-3 个** → pi-ai 的统一调用面开始有价值。
- **4+ 个或包含自部署模型** → pi-ai 几乎是必要的。从头适配每个 provider 的流式 API 差异是大量工作。

### Q3：你的团队是否愿意阅读源码？

pi 不是一个"看文档就能用"的框架。由于功能外置，很多"怎么实现 X"的答案在源码中（看已有产品如何组合），而不在 API 文档中。

- **团队习惯阅读和参考开源项目的源码** → 适合 pi。
- **团队期望完善的 API 文档和教程** → 当前阶段不适合。

### Q4：你的安全模型是什么？

- **sandbox 隔离**（Docker、VM）→ pi 天然支持（见 mom 的 Docker sandbox）。
- **交互式确认** → pi 不内建，但产品层可以基于 `beforeToolCall` 自行实现。
- **基于角色的权限控制** → pi 支持，但完全由产品层实现。
- **需要内建的安全审计和合规** → pi 没有内建，需要自己通过事件订阅实现审计日志。

### Q5：你的迭代速度需求是什么？

- **快速原型，一周内上线 MVP** → pi 的上手成本太高。用 Vercel AI SDK 或 Claude API + 简单循环更快。
- **中期项目，1-3 个月** → 如果团队有 TypeScript 经验，pi 的分层架构值得投入。
- **长期产品，6+ 个月维护** → pi 的可维护性和可扩展性在长期回报最大。

**评估结论：如果 5 个问题中有 3 个以上指向"适合"，pi 是一个合理的选择。如果只有 1-2 个，投入产出比可能不够。**

## 从其他框架迁移到 pi

### 从 LangChain 迁移

LangChain 用户最大的转变是心智模型：从"用框架提供的 Chain/Agent 类"变为"自己组合回调和工具"。

| LangChain 概念 | pi 对应 | 迁移策略 |
|---------------|---------|---------|
| `ChatModel` | `getModel()` + provider | 替换模型初始化代码 |
| `AgentExecutor` | `Agent` + `agentLoop` | 重写主循环（通常更简单） |
| `Tool` | `AgentTool<TParams>` | 接口相似，改 schema 格式 |
| `Memory` | `SessionManager` | 替换持久化逻辑 |
| `Chain` | `transformContext` + tool 组合 | 分解为回调和工具调用 |
| `CallbackHandler` | 事件订阅 | 订阅 `AgentEvent` |
| `OutputParser` | 直接处理 assistant message | 无需 parser 层 |

迁移核心步骤：

1. **替换模型层**。内建 provider 直接用 `getModel("provider", "model")`；如果你有自定义 provider，再额外接入 `registerApiProvider()`
2. **重写工具**。将 `@tool` 装饰器改为 `AgentTool` 对象。schema 从 Pydantic 改为 JSON Schema
3. **删除 Chain**。大多数 Chain 的功能用 `transformContext` 就够了
4. **替换 Memory**。用 SessionManager 替换 LangChain 的 BufferMemory/ConversationMemory
5. **重写 Agent 循环**。通常比 LangChain 的 AgentExecutor 更短（pi 的循环引擎做了更多事）

### 从 Vercel AI SDK 迁移

Vercel AI SDK 是轻量级方案。迁移到 pi 通常是因为需要更复杂的工具执行管道或多产品支持。

| Vercel AI SDK | pi 对应 | 迁移策略 |
|--------------|---------|---------|
| `streamText()` | `streamSimple()` | 替换调用 |
| `tool()` | `AgentTool` | 类似接口 |
| `generateText()` | `Agent.prompt()` | 替换为 agent 循环 |
| `useChat()` (React) | 自行实现或用 web-ui | 需要自建 UI 层 |

迁移核心步骤：

1. **替换流式调用**。`streamText()` → `streamSimple()`，事件格式略有不同
2. **添加 agent 循环**。Vercel AI SDK 没有内建循环，pi 的 `agentLoop` 提供自动工具调用
3. **如果需要 React UI**，可以参考 pi-web-ui 直接持有 `Agent` 的方式，或者单独参考 `modes/rpc/` 构建 headless 后端

### 从 Claude Code 扩展到 pi

如果你已经在使用 Claude Code 并想构建自己的产品，pi 提供了"从 CLI agent 到平台"的路径。

| Claude Code | pi 对应 | 扩展策略 |
|------------|---------|---------|
| Slash commands | Extension `registerCommand()` | 可复用概念 |
| CLAUDE.md | AGENTS.md + SYSTEM.md | 类似机制 |
| 单一 Anthropic API | 多 provider 支持 | 解锁更多模型 |
| 固定工具集 | 可替换的工具集 | 可定制 |
| CLI only | CLI + Slack + Web + API | 多产品形态 |

## 二次开发指南

### 扩展的二次开发表

| 我想做什么 | 优先修改 | 参考章节 | 复杂度 | 代码量预估 |
|-----------|---------|---------|-------|-----------|
| 加一个新的 provider 实现 | `packages/ai` 中实现 provider + `registerApiProvider()` + model wiring | 第 4、18 章 | 中 | ~200-600 行 |
| 加一个新工具 | Extension → `registerTool()` | 第 15、19 章 | 低 | ~50-200 行 |
| 改 system prompt | 创建 `SYSTEM.md` 或 `AGENTS.md` | 第 13-14 章 | 最低 | 0 行代码 |
| 自定义权限策略 | `beforeToolCall` 钩子 | 第 9 章 | 低 | ~30-100 行 |
| 自定义 compaction | Extension hook: `on("session_before_compact", ...)` | 第 12 章 | 中 | ~100-300 行 |
| 加一个新 UI 模式 | 参考 `modes/rpc/` 实现新 mode | 第 26 章 | 高 | ~500-2000 行 |
| 支持新的消息类型 | `CustomAgentMessages` 声明合并 | 第 10 章 | 中 | ~100-200 行 |
| 自定义会话存储 | 实现新的 SessionManager | 第 11 章 | 中 | ~200-500 行 |
| 加一个新 OAuth provider | `registerOAuthProvider()` | 第 7 章 | 中 | ~200-400 行 |
| 自定义上下文管理 | `transformContext` 回调 | 第 8 章 | 中 | ~50-200 行 |
| 构建 Slack bot | 参考 mom 的架构 | 第 28 章 | 高 | ~2000-4000 行 |
| 构建 Web UI | 参考 web-ui 直接消费 `Agent`，或参考 `modes/rpc/` 做后端 | 第 26、27 章 | 高 | ~3000-5000 行 |
| 添加自部署模型 | 参考 pods 的 vLLM 集成 | 第 29 章 | 中 | ~500-1000 行 |
| 实现 plan mode | `transformContext` + `beforeToolCall` | 第 31 章 | 中 | ~100-300 行 |
| 实现 sub-agent | Agent 工具 + 嵌套循环 | 第 31 章 | 中 | ~100-300 行 |
| 添加审计日志 | 事件订阅 + 日志写入 | 第 10 章 | 低 | ~50-100 行 |
| 实现成本控制 | `transformContext` 检查 token 预算 | 第 8 章 | 低 | ~50-100 行 |

### 关键入口文件

如果你计划二次开发，以下是最常接触的文件：

```
packages/
├── ai/src/
│   ├── api-registry.ts       # 添加 provider 的入口
│   ├── types.ts               # Model, Context, StreamFunction 类型
│   └── models.json            # 模型定义（id, cost, contextWindow）
├── agent/src/
│   ├── agent-loop.ts          # 循环引擎（核心抽象）
│   ├── agent.ts               # Agent 类（状态容器）
│   └── types.ts               # AgentTool, AgentEvent 类型
├── coding-agent/src/core/
│   ├── agent-session.ts       # 产品层的 agent 包装
│   ├── session-manager.ts     # 会话持久化
│   ├── extensions/            # Extension API
│   ├── tools/                 # 内建工具实现
│   ├── system-prompt.ts       # system prompt 装配
│   └── prompt-templates.ts   # prompt 模板
└── tui/src/
    └── tui.ts                 # 终端 UI（如果构建 CLI 产品）
```

### 推荐的二次开发路径

**路径 1：最小改动 — 只换 prompt 和工具**

适合：在 pi 的现有产品形态（CLI）上做领域定制。

1. 创建 `AGENTS.md` 定义领域知识
2. 创建 skills 定义工作流程
3. 可选：通过 Extension 添加领域工具
4. 不需要修改任何 pi 源码

**路径 2：中等改动 — 添加新的产品壳**

适合：在 pi 的内核上构建新的产品形态（如 Discord bot、API 服务）。

1. 参考 mom 的架构，创建新的入口包
2. 实现 `ResourceLoader` 接口
3. 创建产品特定的工具集
4. 接入产品特定的 I/O（消息平台、HTTP 等）
5. 订阅 agent 事件，适配输出格式

**路径 3：深度改动 — 修改内核行为**

适合：需要改变 agent 循环的基本行为（如并行工具执行、自定义停止条件）。

1. Fork pi-agent-core
2. 修改 `agentLoop` 的循环逻辑
3. 扩展 `AgentEvent` 类型（新的事件类型）
4. 注意：需要同步更新依赖 pi-agent-core 的所有上层包

**强烈建议从路径 1 开始**，只在确认现有机制无法满足需求时才进入路径 2 或 3。大多数"我需要修改内核"的需求，最终都可以用 `transformContext` + `beforeToolCall` + Extension 组合解决。

## 长期展望

pi 的架构边界会随生态成熟而变化：

- **更多 Extension 模板** → 降低"组合的门槛"，让常见模式开箱可用
- **MCP 桥接** → 通过 Extension 连接 MCP 生态，解锁跨框架工具互操作
- **多语言 SDK** → Python/Go binding for pi-ai 层，降低技术栈门槛
- **社区 skills 市场** → 类似 npm，分享和发现领域 skills

但核心架构 — 协议式内核、能力外置、三层回调 — 预计不会改变。这是 pi 的设计本体，不是暂时的实现选择。

## 取舍分析

### 得到了什么

**清晰的决策框架**。本章的五个评估问题和二次开发路径为读者提供了结构化的决策依据。不是"pi 好不好"的判断，而是"pi 适不适合你"的分析。

### 放弃了什么

**营销友好的叙事**。诚实地列出"不适合什么"和迁移成本，可能劝退一些潜在用户。但对于真正要用 pi 构建产品的团队，这些信息比"一切皆可"的宣传更有价值。

---

### 版本演化说明
> 本章核心分析基于 pi-mono v0.66.0。适用边界的判断会随着 pi 生态的成熟
>（更多 extension 模板、更完善的文档、可能的多语言 SDK）而变化。
> 二次开发的复杂度估算基于当前代码库，可能随 API 稳定化而降低。
