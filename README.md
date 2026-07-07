<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>

---

# Pi Deep Dive

本项目是开源项目 [pi](https://github.com/earendil-works/pi-mono) 的 fork 解析教程仓库。

## 关于 Pi

[Pi](https://pi.dev) 是一个基于 TypeScript 构建的自扩展编程 Agent，采用 npm workspace monorepo 架构，核心包含四层：

```json
pi-tui (终端渲染库)  ← 零内部依赖，纯 UI / 渲染层

pi-ai  (LLM 统一 API) — 模型、provider、流式事件、成本/usage	 ← 零内部依赖，纯 AI 层

pi-agent-core (agent 引擎) — agent loop、工具执行、事件分发、状态管理  ← 依赖 pi-ai
    
pi-coding-agent (完整 CLI 终端应用) — 会话、命令、工具、TUI、扩展系统  ← 依赖以上三个
```

npm workspace 不保证构建顺序。如果你运行 `npm run build`，npm 会并行构建所有包 — 但包之间有依赖关系，并行构建会失败。

pi-mono 通过在根 `package.json` 的 `build` 脚本中**手动编排构建顺序**来解决这个问题：

```json
{
  "build": "cd packages/tui && npm run build && cd ../ai && npm run build && cd ../agent && npm run build && cd ../coding-agent && npm run build"
}
```

> Pi 奉行近乎激进的可扩展性，因此无需、也不愿替你规定工作流。许多在别的工具中“内建”的能力，在这里都可通过 extensions、skills，或安装第三方 pi packages 来实现。这样既能让核心保持精简，又能让你按自己的工作方式塑造 Pi。
>
> 不做 MCP。 你可以构建带有 README 的 CLI 工具（见 Skills），也可以编写 extension，为 Pi 增加 MCP 支持。为何如此？
>
> 不设 sub-agents。 实现路径有很多：可借助 tmux 启动多个 Pi 实例，或用 extensions 自行搭建，亦可安装按你思路实现的软件包。
>
> 不弹 permission popups。 你可以在容器中运行，或通过 extensions 构建与自身环境及安全要求相匹配的确认流程。
>
> 不设 plan mode。 计划可直接写入文件，或借助 extensions 自行实现，或安装相应软件包。
>
> 不内置 to-dos。 它们容易让模型困惑。请使用 TODO.md，或用 extensions 自定义。
>
> 不提供后台 bash。 请使用 tmux：全程可观测，交互更直接。

`OpenClaw` 底层的 Agent 正是基于 `Pi Agent` 框架实现的（具体而言，`OpenClaw`通过 `RPC` 模式或 `SDK` 方式集成了 `pi-coding-agent`）

## 项目定位

本仓库 fork 自上游 `pi-mono` 源码，在基本不改变原有代码逻辑的前提下：

- 为各核心模块的关键类、函数、类型和流程添加了**详细的中文注释**
- 整理了 Pi 项目的**整体架构分析和逐层源码解读**，目录见下文

适合对 AI Agent 内部实现感兴趣、想了解工业级 Coding Agent 设计思想的开发者。

## 快速开始

```bash
npm install --ignore-scripts
npm run build
npm run check
./test.sh
./pi-test.sh
```

* `npm install --ignore-scripts`：安装所有 workspace 依赖至 `node_modules`，`--ignore-scripts` 跳过 npm 生命周期脚本（postinstall 等），防止依赖中的脚本自动执行，避免供应链安全问题。

* `npm run build`：按依赖顺序编译四个核心包至 `dist`：package.json#L14

  ```bash
  tui → ai → agent → coding-agent
  ```

  TypeScript 源码编译为 JS，生成可运行的产物。

* `npm run check`：代码质量检查套件，包含五项子任务：package.json#L15

  - `biome check` — 代码格式化 + lint

  - `check:pinned-deps` — 验证外部依赖是否为精确版本

  - `check:ts-imports` — 检查 TypeScript 的 import 路径规范

  - `check:shrinkwrap` — 验证 coding-agent 的 shrinkwrap 与 lockfile 一致

  - `tsgo --noEmit` — 全量类型检查（不产出文件）

  - `check:browser-smoke` — 浏览器模块兼容性冒烟测试


* `./test.sh`：在**无 API Key 环境**下运行测试。脚本会：test.sh：

  - 备份 `~/.pi/agent/auth.json`

  - 清除所有 LLM provider 的环境变量（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等）

  - 运行 `npm test`，跳过依赖 LLM 的集成测试，只跑本机可执行的单元测试


* `./pi-test.sh`：从源码直接启动 Pi CLI，无需编译发布。脚本用 `tsx` 直接执行 `packages/coding-agent/src/cli.ts`：pi-test.sh#L57
  * 支持 `--no-env` 参数清空 API Key 后运行（仅查看模型列表等不调用 LLM 的功能）。可在任意目录下执行。

## 教程目录

> 参考资料：
>
> * [pi 作者博客: What I learned building an opinionated and minimal coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)（🌟🌟🌟）
> * [pi-book](https://github.com/ZhangHanDong/pi-book)（🌟🌟🌟）
> * [深度解析：pi-ai 与 pi-agent-core](https://guangzhengli.com/notes/pi-ai-and-agent-core-course)（🌟🌟）
> * [Pi Agent 原理与实现](https://github.com/cellinlab/how-pi-agent-works)（🌟）

1. [pi-ai](./pi-ai.md)

   [pi-ai-streaing-architecture](./pi-ai-streaing-architecture.md)

2. [pi-agent](./pi-agent.md)

3. [pi-coding-agent](./pi-coding-agent.md)

4. 其他

   [Javascript、Typescript 相关知识（语法、项目）](./JS&TS-notes.md)

   [monorepo-config 根目录配置文件](./monorepo-config.md)

   [仓库 script 文件夹下的脚本](./scripts.md)
   
   [官方 sandbox extension 示例解析](./sandbox.md)


## 使用技巧

> [Pi Agent 极简入门](https://www.bilibili.com/video/BV1mAEh6jEYU)

`/settings` — 进行一系列设置，包括 themes

`!xxx` — 执行 bash 命令，`!!xxx` — 也是执行 bash 命令，但是不会被放到对话记录中

`/scoped-models` — 收藏常用模型，退出后按 `Ctrl+P` 即可在收藏的模型中循环切换

`Shift+Tab` — 切换思考强度

.pi/agent/prompts 下放了prompt 模板

可以让 pi 自己生成一个 /xxx 的 prompt 命令

skills 放置文件夹：.agents/skills/ .cloude/skills .pi/agent/skills

可以通过创建**符号链接（symlink）** 的方式，让 Claude Code 读取到 `.agents/skills` 文件夹下的技能。

1.  **确保目录存在**：首先，确认你的技能源目录 `.agents/skills` 已经存在。然后，为 Claude 创建目标目录 `.claude`。
    ```bash
    mkdir -p .agents/skills
    mkdir -p .claude
    ```

2.  **创建符号链接**：在项目根目录下执行以下命令。
    ```bash
    ln -s ../.agents/skills .claude/skills
    ```
    这条命令会在 `.claude/` 目录下创建一个名为 `skills` 的符号链接，它会指向上一级目录（`../`）中的 `.agents/skills` 文件夹。

执行后，你的目录结构应该类似于这样：
```
├── .agents/
│   └── skills/        # 唯一的技能源目录
│       └── your-skill/
└── .claude/
    └── skills -> ../.agents/skills  # 指向源目录的符号链接
```

创建成功后，你只需维护 `.agents/skills` 这一个目录。你对它做的任何修改，Claude Code 都能通过这个符号链接即时看到。

session 相关

* `/name xxx` — 命名本 session 对话
* `/resume` — 恢复某个 session 会话
* `/session` — 显示本 session 信息，包括 name、file（jsonl 存放地址，一般在 .pi/agent/sessions 文件夹下）、id、对话数、token 数、cost
* `/tree` — 跳转到 session 某个对话树节点位置
* `/fork` `/clone`
* `/export` — 导出对话 html 格式到当前文件夹下，运行 `!open xxx.html` 即可打开

`/compact xxx（你想加的额外 prompt）`

### Extension

pi-guard-sandbox

pi-web-access 

pi-mcp-adapter 

https://github.com/jiangge/pi-cache-optimizer 

plan-mode


## 许可证

MIT