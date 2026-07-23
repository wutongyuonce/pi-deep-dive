<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>

---

# Pi Deep Dive

本项目是开源项目 [pi](https://github.com/earendil-works/pi-mono) 的 fork 解析教程仓库。

0.80.10
Commits on Jul 17, 2026
Add [Unreleased] section for next cycle

Commits on Jul 22, 2026
fix(coding-agent): defer catalog refresh until after TUI startup


## 关于 Pi

[Pi](https://pi.dev) 是一个基于 TypeScript 构建的自扩展编程 Agent，采用 npm workspace monorepo 架构，核心包含四层：

```
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

## 指南

详见[README](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#readme)

### 编辑器

（指的是输入框）

| 功能      | 用法                                                         |
| :-------- | :----------------------------------------------------------- |
| 文件引用  | 输入 `@` 可模糊搜索项目文件                                  |
| 路径补全  | 按 `Tab` 自动补全路径                                        |
| 多行输入  | `Shift+Enter`（Windows Terminal 下也可用 `Ctrl+Enter`）      |
| 图片      | `Ctrl+V` 粘贴（Windows 下可用 `Alt+V`），或直接拖到终端      |
| Bash 命令 | `!command` 执行并把输出发给模型，`!!command` 执行但不发送输出 |

删除单词、撤销等使用标准编辑快捷键。详见 [此处](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/keybindings.md)。

### 命令

在编辑器里输入 `/` 可触发命令。[扩展](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#extensions)可注册自定义命令，[技能](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#skills)可用 `/skill:name` 调用，[提示词模板](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#prompt-templates)可通过 `/templatename` 展开。

| 命令                | 说明                                                   |
| :------------------ | :----------------------------------------------------- |
| `/login`,`/logout`  | OAuth 登录/退出                                        |
| `/model`            | 切换模型                                               |
| `/scoped-models`    | 启用/禁用 `Ctrl+P` 轮换可选模型                        |
| `/settings`         | 设置思考等级、主题、消息投递、传输方式                 |
| `/resume`           | 从历史会话中恢复                                       |
| `/new`              | 新建会话                                               |
| `/name <name>`      | 设置会话显示名称                                       |
| `/session`          | 显示会话信息（路径、Token、费用）                      |
| `/tree`             | 跳转到会话任意节点并从那继续                           |
| `/fork`             | 从当前分支创建新会话                                   |
| `/compact [prompt]` | 手动压缩上下文，可自定义压缩提示                       |
| `/copy`             | 复制助手上一条回复到剪贴板                             |
| `/export [file]`    | 导出会话为 HTML 文件                                   |
| `/share`            | 上传为私有 GitHub Gist，并生成可分享 HTML 链接         |
| `/reload`           | 重载扩展、技能、提示词、上下文文件（主题会自动热更新） |
| `/hotkeys`          | 显示全部快捷键                                         |
| `/changelog`        | 显示版本更新记录                                       |
| `/quit`,`/exit`     | 退出 pi                                                |

### 消息队列

智能体工作时，你也可以继续发消息：

- **Enter**：排入一条*引导消息*，会在当前工具执行完后立即送达（并中断后续未执行工具）
- **Alt+Enter**：排入一条*跟进消息*，只会在代理完成全部工作后送达
- **Escape**：中止当前过程，并把已排队消息恢复到编辑器
- **Alt+Up**：把队列中的消息取回到编辑器

可在 [settings](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md) 配置投递方式：`steeringMode` 和 `followUpMode` 可设为 `"one-at-a-time"`（默认，收到回复后再发下一条）或 `"all"`（一次性发送队列全部消息）。`transport` 用于选择支持多传输的提供方通道偏好（`"sse"`、`"websocket"` 或 `"auto"`）。

### 会话

会话以 JSONL 树结构保存。每条记录都有 `id` 和 `parentId`，所以可以在同一个文件里直接分支，不必新建文件。文件格式见 [此处](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md)。

### 管理

会话会自动保存到 `~/.pi/agent/sessions/`，并按工作目录（cwd）分组。

- `pi -c`：继续最近一次会话
- `pi -r`：浏览并选择历史会话
- `pi --no-session`：临时模式（不保存会话）
- `pi --session <path>`：使用指定会话文件或会话 ID

### 分支

**`/tree`**：在当前会话文件内浏览会话树。你可以选中任意历史节点，从那继续，并在不同分支间切换。所有历史都保留会话文件中。

![tree-view](img/fef44c9acaf8a1487a3d89bfc8e4ee9db9483049.png)

- 输入关键词可搜索，`←/→` 翻页
- 过滤模式（Ctrl+O）：default → no-tools → user-only → labeled-only → all
- 按 `l` 可给条目标记书签

**`/fork`**：从当前分支创建一个新的会话文件。系统会打开选择器，复制到所选节点为止的历史，并把该节点消息放入编辑器，方便你继续修改。

### 设置

使用 `/settings` 修改常用选项，或直接编辑 JSON 文件：

| 位置                        | 范围 |
| :-------------------------- | :--- |
| `~/.pi/agent/settings.json` | 全局 |
| `.pi/settings.json`         | 项目 |

详见[此处](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md)。

### 项目上下文

Pi 在启动时会从以下位置加载 `AGENTS.md`（或 `CLAUDE.md`）：

- `~/.pi/agent/AGENTS.md` (全局)
- 父目录（从当前工作目录向上查找）
- 当前目录

用于项目说明、约束和常用命令封装。所有匹配的md文件将被拼接在一起。

#### 系统提示

用 `.pi/SYSTEM.md`（项目）或 `~/.pi/agent/SYSTEM.md`（全局）替换系统提示词或通过 `APPEND_SYSTEM.md` 追加在系统提示词末尾。

### 自定义

这部分的内容都可以封装为[pi package](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#pi-packages)。

这里整理了公开的 Pi 包

[Packages - pi.dev](https://pi.dev/packages)

#### 提示词模板

将提示词封装为Markdown文件，输入`/文件名`展开。

```markdown
<!-- ~/.pi/agent/prompts/review.md --> 
Review this code for bugs, security issues, and performance problems. Focus on: {{focus}}
```

放置在 `~/.pi/agent/prompts/`（全局）, `.pi/prompts/`（项目）或封装为 [pi package](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#pi-packages) 分享给别人.

#### 技能

按需加载的技能包，遵循 [Agent Skills 标准](https://agentskills.io/)。可通过输入/skill:name 调用，也可让 Agent 自动加载。

```markdown
<!-- ~/.pi/agent/skills/my-skill/SKILL.md --> 
# My Skill Use this skill when the user asks about X. 

## Steps 
1. Do this 
2. Then that
```

安装路径：

全局

- `~/.pi/agent/skills/`
- `~/.agents/skills/`

项目

- `.pi/skills/`
- `.agents/skills/`（从当前工作目录向上逐级查找父目录）

或封装为 [pi package](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#pi-packages)。

详见[此处](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md).

pi作者维护的[技能包](https://github.com/badlogic/pi-skills)，包含浏览器控制，brave搜索等技能，pi和其它支持skill的项目都能直接使用。

#### 扩展

放入 `~/.pi/agent/extensions/`（全局）、`.pi/extensions/`（项目）或封装为 [pi package](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#pi-packages) 分享给别人。

参见[文档](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)和[例子](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions)。

#### 主题

内置暗色与明亮，修改主题配置后可热重载。

放入`~/.pi/agent/themes/`（全局），`.pi/themes/`（项目）或封装为 [pi package](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#pi-packages) 分享给别人。

详见[此处](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/themes.md)。

**通过扩展与主题系统可以极大增强我们的使用体验！！！** 直接对模型说出需求即可，因为pi的系统提示词中包含了pi的文档路径。