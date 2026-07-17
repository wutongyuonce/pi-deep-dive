# pi-goal

Persistent `/goal` support for pi. The extension ports the useful parts of Codex goal mode into a pi package: a session-scoped goal store, Codex-style TUI footer indicator, hidden continuation prompts, token/time accounting, and agent-callable tools.

## Installation

```bash
pi install npm:pi-goal
```

For local development:

```bash
pi -e ./src/index.ts
```

## Commands

```bash
/goal <objective>
/goal
/goal pause
/goal resume
/goal clear
```

Goals are stored under Pi's active session directory, keyed by session id. If Pi is launched without a persisted session, the extension falls back to `$PI_CODING_AGENT_DIR/extensions/pi-goal/...`. That means `PI_CODING_AGENT_DIR=$HOME/.senpi/agent` keeps goal state under `~/.senpi/agent/...` even when pi is launched from a workspace such as `~/local-workspaces/senpi-mono`.

## Agent Tools

- `create_goal({ objective, token_budget? })` creates a new active goal. This follows Codex's model-facing schema.
- `update_goal({ status: "complete" })` only marks the current goal complete. Pause, resume, budget-limited, and clear transitions are user/system controlled.
- `get_goal({})` returns the current goal summary.

Statuses are `active`, `paused`, `budgetLimited`, and `complete`. When a goal reaches its token budget, the extension marks it `budgetLimited` and queues a prompt asking the agent to summarize remaining work instead of silently continuing.

## TUI Behavior

When a goal exists, pi keeps the normal footer information and renders the Codex-style goal indicator on the bottom-right footer line: `Pursuing goal (...)`, `Goal paused (/goal resume)`, `Goal unmet (...)`, or `Goal achieved (...)`. The older below-editor goal widget is cleared.

On session start, after `/goal <objective>`, after `/goal resume`, and after every agent turn that leaves the goal `active`, the extension queues Codex's goal continuation prompt as hidden model-visible context. The objective is XML-escaped and wrapped as untrusted user data so it does not become higher-priority instructions.

## Development

```bash
npm test
npm run typecheck
npm run check
npm run no-excuse
npm pack --dry-run
```

The implementation is strict TypeScript and mirrors sibling pi extension metadata, CI, and package layout. `npm run check` runs `tsgo --noEmit`, `biome check .`, and the TypeScript no-excuse checker.

---

## 中文翻译

# pi-goal

为 pi 提供持久化的 `/goal` 支持。该扩展将 Codex goal 模式中的实用部分移植到 pi 包中：会话范围的目标存储、Codex 风格的 TUI 底部状态指示器、隐藏的延续提示、token/时间统计，以及可供代理调用的工具。

## 安装

```bash
pi install npm:pi-goal
```

本地开发：

```bash
pi -e ./src/index.ts
```

## 命令

```bash
/goal <目标描述>
/goal
/goal pause
/goal resume
/goal clear
```

目标存储在 Pi 的活动会话目录下，按会话 ID 索引。如果 Pi 启动时没有持久化会话，扩展会回退到 `$PI_CODING_AGENT_DIR/extensions/pi-goal/...`。这意味着设置 `PI_CODING_AGENT_DIR=$HOME/.senpi/agent` 后，即使从 `~/local-workspaces/senpi-mono` 之类的工作区启动 pi，目标状态也会保存在 `~/.senpi/agent/...` 下。

## Agent 工具

- `create_goal({ objective, token_budget? })` 创建一个新的活动目标。遵循 Codex 面向模型的 schema。
- `update_goal({ status: "complete" })` 仅将当前目标标记为完成。暂停、恢复、预算受限和清除等状态转换由用户/系统控制。
- `get_goal({})` 返回当前目标摘要。

状态包括 `active`（活动）、`paused`（已暂停）、`budgetLimited`（预算受限）和 `complete`（已完成）。当目标达到 token 预算时，扩展会将其标记为 `budgetLimited`，并排队一条提示，要求代理总结剩余工作，而不是静默继续。

## TUI 行为

当存在目标时，pi 保留正常的底部信息栏，并在右下角渲染 Codex 风格的目标指示器：`Pursuing goal (...)`（正在执行目标）、`Goal paused (/goal resume)`（目标已暂停）、`Goal unmet (...)`（目标未达成）或 `Goal achieved (...)`（目标已达成）。旧的编辑器下方目标小部件会被清除。

在会话启动时、执行 `/goal <目标描述>` 后、执行 `/goal resume` 后，以及每次代理回合结束后目标仍为 `active` 状态时，扩展会将 Codex 的目标延续提示作为隐藏的模型可见上下文排队。目标描述会经过 XML 转义并包装为不受信任的用户数据，以免其成为更高优先级的指令。

## 开发

```bash
npm test
npm run typecheck
npm run check
npm run no-excuse
npm pack --dry-run
```

实现采用严格的 TypeScript，并与同级 pi 扩展的元数据、CI 和包布局保持一致。`npm run check` 会运行 `tsgo --noEmit`、`biome check .` 和 TypeScript no-excuse 检查器。
