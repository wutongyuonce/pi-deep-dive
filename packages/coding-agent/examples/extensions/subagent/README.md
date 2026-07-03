# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent

---

# 中文翻译

## Subagent 示例

将任务委派给具备专长的子代理，并为每个子代理提供彼此隔离的上下文窗口。

## 功能特性

- **隔离上下文**：每个子代理都运行在独立的 `pi` 进程中
- **流式输出**：可以实时看到工具调用和执行进度
- **并行流式展示**：并行任务会同时流式输出更新
- **Markdown 渲染**：最终输出会以正确格式渲染（展开视图）
- **用量追踪**：展示每个 agent 的轮次、token、成本和上下文使用情况
- **支持中止**：`Ctrl+C` 会向下传播并终止子代理进程

## 目录结构

```text
subagent/
├── README.md            # 本文件
├── index.ts             # 扩展入口
├── agents.ts            # Agent 发现逻辑
├── agents/              # 示例 agent 定义
│   ├── scout.md         # 快速侦察，返回压缩后的上下文
│   ├── planner.md       # 生成实现计划
│   ├── reviewer.md      # 代码审查
│   └── worker.md        # 通用型 agent（完整能力）
└── prompts/             # 工作流预设（prompt 模板）
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner（不做实现）
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## 安装方式

在仓库根目录执行下面的符号链接命令：

```bash
# 链接扩展（必须位于一个包含 index.ts 的子目录中）
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# 链接 agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# 链接工作流 prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## 安全模型

这个工具会启动一个独立的 `pi` 子进程，并向它委派专用的 system prompt、工具配置和模型配置。

**项目级 agent**（`.pi/agents/*.md`）是由仓库控制的 prompt，它们可以指示模型读取文件、执行 bash 命令等。

**默认行为：** 只加载 **用户级 agents**，即 `~/.pi/agent/agents` 下的 agent。

如果要启用项目级 agent，请传入 `agentScope: "both"`（或 `"project"`）。只有在你信任当前仓库时才应该这样做。

在交互模式下，工具会在运行项目级 agent 前请求确认。设置 `confirmProjectAgents: false` 可以关闭该确认。

## 用法

### 单个 agent

```text
Use scout to find all authentication code
```

### 并行执行

```text
Run 2 scouts in parallel: one to find models, one to find providers
```

### 链式工作流

```text
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### 工作流 prompts

```text
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## 工具模式

| 模式 | 参数 | 说明 |
|------|------|------|
| Single | `{ agent, task }` | 一个 agent，执行一个任务 |
| Parallel | `{ tasks: [...] }` | 多个 agent 并发运行（最多 8 个任务，同时并发 4 个） |
| Chain | `{ chain: [...] }` | 顺序执行，支持 `{previous}` 占位符 |

## 输出展示

**折叠视图**（默认）：

- 状态图标（✓/✗/⏳）和 agent 名称
- 最近 5 到 10 条内容（工具调用和文本）
- 用量统计：`3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**展开视图**（`Ctrl+O`）：

- 完整任务文本
- 所有工具调用及其格式化参数
- 以 Markdown 渲染的最终输出
- 每个任务的单独用量信息（适用于 chain/parallel）

**并行模式流式输出**：

- 实时显示所有任务状态（⏳ 运行中，✓ 已完成，✗ 失败）
- 每个任务有进展时都会更新
- 展示类似 “2/3 done, 1 running” 的总体状态
- 每个完成任务的最终输出会返回给父模型，每个任务最多 50 KB
- 如果子进程在产生输出前就退出，会把 stderr 或错误信息作为失败诊断返回

**工具调用格式**（模仿内置工具）：

- `bash` 显示为 `$ command`
- `read` 显示为 `read ~/path:1-10`
- `grep` 显示为 `grep /pattern/ in ~/path`
- 其他工具以类似风格展示

## Agent 定义

Agent 是带 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**位置：**

- `~/.pi/agent/agents/*.md` - 用户级（始终加载）
- `.pi/agents/*.md` - 项目级（仅当 `agentScope: "project"` 或 `"both"` 时加载）

当 `agentScope: "both"` 时，项目级 agent 会覆盖同名的用户级 agent。

## 示例 Agents

| Agent | 用途 | 模型 | 工具 |
|-------|------|------|------|
| `scout` | 快速代码库侦察 | Haiku | read, grep, find, ls, bash |
| `planner` | 制定实现计划 | Sonnet | read, grep, find, ls |
| `reviewer` | 代码审查 | Sonnet | read, grep, find, ls, bash |
| `worker` | 通用型 agent | Sonnet | （所有默认工具） |

## 工作流 Prompts

| Prompt | 流程 |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## 错误处理

- **退出码不为 0**：工具返回包含 stderr/输出内容的错误
- **`stopReason` 为 `"error"`**：将 LLM 错误和错误信息向上传递
- **`stopReason` 为 `"aborted"`**：用户中止（`Ctrl+C`）会杀掉子进程并抛出错误
- **链式模式**：在第一个失败步骤处停止，并报告是哪个步骤失败

## 限制

- 折叠视图下只显示最后 10 条内容（展开后可查看全部）
- 并行模式下返回给模型的输出上限为每个任务 50 KB；完整结果仍保留在工具详情中
- 每次调用都会重新发现 agents（因此支持在会话中途修改）
- 并行模式最多 8 个任务，同时最多并发 4 个
