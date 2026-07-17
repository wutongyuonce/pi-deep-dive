# pi-plan-mode 项目解析

## 一、项目概览

`@narumitw/pi-plan-mode` 是一个 Pi 编码助手的扩展模块，提供 Codex 风格的 **Plan Mode（规划模式）**。核心思想是：在只读环境中与 Agent 协作完成技术方案的决策与设计，产出 `<proposed_plan>` 后再进入实现阶段。整个模块约 1100 行 TypeScript，全部集中在 [plan-mode.ts](file:///Users/a/Desktop/pi-plan-mode/src/plan-mode.ts) 单文件中。

**核心状态机**只有三个字段：

```
PlanModeState {
  enabled: boolean        // Plan Mode 是否激活
  latestPlan?: string      // 最新的 <proposed_plan> 内容
  awaitingAction: boolean  // 是否等待用户行动
}
```

---

## 二、竖切面链路分析

### 链路 1：扩展注册与启动链路

```
Pi 启动 → 读取 package.json pi.extensions → import plan-mode.ts
→ planMode(pi) 注册 flag/command/tool/hooks
```

**入口**：[`planMode(pi: ExtensionAPI)`](file:///Users/a/Desktop/pi-plan-mode/src/plan-mode.ts#L239-L241)

在函数内依次注册：

| 注册内容 | 类型 | 说明 |
|---|---|---|
| `registerFlag("plan")` | CLI Flag | 支持 `--plan` 命令行参数，启动时直接进入 Plan Mode |
| `registerTool("plan_mode_question")` | Tool | Agent 可调用的结构化提问工具 |
| `registerCommand("plan")` | Command | `/plan` 用户命令（含 exit/off/tools 子命令） |
| `on("session_start")` | Hook | 会话启动时从持久化恢复状态 |
| `on("session_shutdown")` | Hook | 会话关闭时持久化状态 |
| `on("tool_call")` | Hook | 拦截 mutating 工具调用 |
| `on("context")` | Hook | 清理上下文中的 plan mode 遗留数据 |
| `on("before_agent_start")` | Hook | Agent 启动前注入 Plan Mode system prompt |
| `on("agent_end")` | Hook | Agent 结束后检测 `<proposed_plan>` |

---

### 链路 2：会话状态持久化与恢复链路

```
session_start → restoreState(ctx) → 读取 sessionManager 中的 custom entry
→ 恢复 state {enabled, latestPlan, awaitingAction, selectedToolNames}
→ 若 --plan flag 为 true → state.enabled = true
→ activatePlanModeTools() / deactivatePlanModeQuestionTool()
→ updateUi(ctx) 更新状态栏和 Widget
```

```
session_shutdown → persistState() → pi.appendEntry(TYPE, state) → clearUi(ctx)
```

**持久化关键细节**：
- 存储类型标识为 `STATE_ENTRY_TYPE = "plan-mode-state"`
- 使用 `sessionManager.getEntries()` 读取并过滤 `type === "custom" && customType === STATE_ENTRY_TYPE` 的最后一个条目（[restoreState](file:///Users/a/Desktop/pi-plan-mode/src/plan-mode.ts#L681-L695)）
- 若 Plan Mode 已关闭，恢复时丢弃 `latestPlan` 和 `awaitingAction`

**UI 更新逻辑**（[updateUi](file:///Users/a/Desktop/pi-plan-mode/src/plan-mode.ts#L697-L713)）：
- `enabled && latestPlan` → 状态栏显示 `"plan ready"`，Widget 显示 "Proposed plan ready"
- `enabled && !latestPlan` → 状态栏显示 `"plan active"`，Widget 显示 "Plan mode: planning"
- `!enabled` → 清除状态栏和 Widget

---

### 链路 3：Plan Mode 进入/退出链路

#### 3.1 进入链路

```
用户输入 /plan [prompt] → command handler 分发参数
```

[`/plan` 命令处理](file:///Users/a/Desktop/pi-plan-mode/src/plan-mode.ts#L297-L324) 的分支逻辑：

```
参数分发树：
├── "exit" / "off" → exitPlanMode(ctx)
├── "tools" → enterPlanMode(ctx) [if not enabled] → showToolSelector(ctx)
├── 有 prompt → enterPlanModeWithPrompt(prompt, ctx)
│     ├── enterPlanMode(ctx) → state.enabled = true
│     └── sendPlanModeUserMessage(prompt, ctx) → 发送用户消息触发 Agent turn
├── 不在 plan mode → enterPlanMode(ctx)
└── 已在 plan mode → showPlanMenu(ctx)
```

`enterPlanMode` 的核心操作（[L415-L421](file:///Users/a/Desktop/pi-plan-mode/src/plan-mode.ts#L415-L421)）：
1. 备份当前活跃工具列表到 `previousTools`（用于退出时恢复）
2. 设置 `state = { enabled: true, awaitingAction: false }`
3. 调用 `activatePlanModeTools()` 激活 Plan Mode 工具集
4. 持久化状态 → 更新 UI

#### 3.2 退出链路

```
/plan exit | /plan off → exitPlanMode(ctx)
→ state = { enabled: false, latestPlan: undefined, awaitingAction: false }
→ restoreTools() 恢复之前保存的工具列表
→ persistState() + updateUi(ctx)
```

---

### 链路 4：工具管理与安全限制链路

这是 Plan Mode 最核心的安全保障。

#### 4.1 工具激活

```
activatePlanModeTools() → applyPlanModeTools() → pi.setActiveTools(planModeToolNames())
```

`planModeToolNames()`（[L595-L605](file:///Users/a/Desktop/pi-plan-mode/src/plan-mode.ts#L595-L605)）的逻辑：
1. 若无可选工具 → 返回 `["read", "bash", "plan_mode_question"]`
2. 从 `state.selectedToolNames` 中筛选用户已选且可选的内置工具
3. 强制追加 `plan_mode_question`（通过 `withRequiredPlanModeTools`）

#### 4.2 内置工具白名单/黑名单

| 策略 | 工具 | 
|---|---|
| 白名单（默认启用） | `read`, `bash`, `grep`, `find`, `ls` + `plan_mode_question` |
| 黑名单（强制阻止）| `edit`, `write` |
| 扩展工具 | 默认禁用，需用户通过 `/plan tools` 手动启用 |

#### 4.3 Bash 命令安全过滤

双层正则匹配（[isSafeCommand](file:///Users/a/Desktop/pi-plan-mode/src/plan-mode.ts#L1020-L1025)）：

**危险命令黑名单（`MUTATING_BASH_PATTERNS`）**：
- 文件操作：`rm`, `rmdir`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`, `chgrp`, `ln`, `tee`, `truncate`, `dd`
- 重定向：`>`, `>>`
- 包管理：`npm install/uninstall/update`, `yarn add/remove`, `pnpm add/remove`, `pip install/uninstall`
- Git 修改：`git add/commit/push/pull/merge/rebase/reset/checkout/switch/stash/cherry-pick/revert/tag/init/clone`
- 系统操作：`sudo`, `su`, `kill`, `pkill`, `killall`, `reboot`, `shutdown`, `systemctl`, `service`
- 编辑器：`vim`, `nano`, `emacs`, `code`, `subl`

**安全命令白名单（`SAFE_BASH_PATTERNS`）**：
- 标准只读工具：`cat`, `head`, `tail`, `less`, `more`, `grep`, `find`, `ls`, `pwd`, `echo`, `wc`, `sort`, `uniq`, `diff`, `file`, `stat`, `du`, `df`, `tree`, `which`, `whereis`, `type`, `env`, `printenv`, `uname`, `whoami`, `id`, `date`, `uptime`, `ps`, `jq`, `awk`, `rg`, `fd`, `bat`, `eza`
- `sed -n`（只能打印，不能原地修改）
- `git status/log/diff/show/branch/remote/config --get/ls-files/grep`（只读 git 子命令）
- `npm list/ls/view/info/search/outdated/audit`（只读 npm 子命令）
- 各工具 `--version` 检查

#### 4.4 工具选择器链路

```
/plan tools → showToolSelector(ctx) → 分页展示可选工具
→ 用户勾选/取消勾选 → state.selectedToolNames 更新
→ applyPlanModeTools() → persistState()
```

分页机制：每页 10 个工具（`TOOL_SELECTOR_PAGE_SIZE`），支持 Previous/Next 翻页。

#### 4.5 tool_call 拦截链路

```
Agent 调用任何工具 → on("tool_call") hook 触发
├── toolName 在 BLOCKED_BUILTIN_TOOLS 中 → { block: true, reason: "..." }
├── toolName === "bash" → 读取命令 → isSafeCommand() 检查
│   ├── 不安全 → { block: true, reason: "..." }
│   └── 安全 → 允许执行
└── 其他工具 → 允许执行
```

**注意**：非内置扩展工具的调用不受 Bash 安全过滤约束，用户需自行评估风险后通过工具选择器启用。

---

### 链路 5：Agent 交互与 Prompt 注入链路

```
before_agent_start → 检查 state.enabled
→ 清除 stale plan（latestPlan / awaitingAction）
→ applyPlanModeTools()
→ 注入 Plan Mode system prompt 追加到原有 systemPrompt 后面
```

**注入的 Prompt**（[buildPlanModePrompt](file:///Users/a/Desktop/pi-plan-mode/src/plan-mode.ts#L961-L1012)）包含三个阶段的指导：

| 阶段 | 说明 |
|---|---|
| **Phase 1 — Ground in the environment** | 先探索再提问，只读方式检查代码库，不提问可从仓库中自行发现的问题 |
| **Phase 2 — Intent chat** | 持续对话直到目标、成功标准、范围、约束、偏好都明确 |
| **Phase 3 — Implementation chat** | 细化方案：技术路线、接口、数据流、边界条件、测试标准、迁移兼容性 |

**Finalization rule**：只有当方案"决策完备"时才输出 `<proposed_plan>`，格式固定为 Title / Summary / Key Changes / Test Plan / Assumptions。

---

### 链路 6：Proposed Plan 检测与实现启动链路

这是 Plan Mode 的核心价值闭环：

```
agent_end → latestAssistantText(messages) 提取最后一条 assistant 消息文本
→ extractProposedPlan(text) 正则匹配 <proposed_plan>...</proposed_plan>
→ 未匹配 → persistState() + updateUi() 继续 planning
→ 匹配成功 → state = { ..., latestPlan: plan, awaitingAction: true }
→ persistState() + updateUi()
→ scheduleAfterCurrentAgentRun() 异步延迟执行：
  ├── ctx.hasUI → showPlanReadyMenu(ctx)
  │     ├── "Implement this plan" → startImplementation(ctx)
  │     ├── "Stay in Plan mode" → 不操作（保留 plan）
  │     └── "Exit Plan mode" → exitPlanMode(ctx)
  └── 发送 proposed_plan 消息（display: true, triggerTurn: false）
```

**实现启动**（[startImplementation](file:///Users/a/Desktop/pi-plan-mode/src/plan-mode.ts#L454-L467)）：
1. 提取 `state.latestPlan`
2. 退出 Plan Mode（恢复完整工具集）
3. 构造实现提示：`"Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:\n\n{plan}"`
4. 作为用户消息发送，触发 Agent 实现 turn

**关键设计点**：
- `scheduleAfterCurrentAgentRun` 使用 `setTimeout(0)` 确保在当前 agent run 完全结束后再执行
- 发送 proposed_plan 消息时 `triggerTurn: false`，不触发额外的 agent turn
- 若用户选择 "Stay in Plan mode" 后再次输入提示，下一个 `before_agent_start` 会清除 `latestPlan`，直到 Agent 输出新的 `<proposed_plan>`

---

### 链路 7：plan_mode_question 工具链路

```
Agent 调用 plan_mode_question(questions) →
├── Plan Mode 未激活 → cancelled("plan_mode_inactive")
├── 参数校验失败 → cancelled("invalid_input")
├── 无 UI → cancelled("ui_unavailable")
├── 正常流程 → askPlanModeQuestions()
│     ├── 逐题展示：header + question + options (2-4个)
│     ├── 支持 "Other (free-form)" 自定义回答
│     ├── 用户取消 → 返回 undefined → cancelled("cancelled")
│     └── 全部回答完毕 → planModeQuestionAnswered()
└── 返回结构化 JSON payload 给 Agent
```

**参数校验**（[normalizePlanModeQuestionParams](file:///Users/a/Desktop/pi-plan-mode/src/plan-mode.ts#L820-L881)）：
- questions 必须是数组，1-3 个问题
- 每个 question 必须有 `id`, `header`, `question`, `options`
- options 必须是数组，2-4 个选项
- 每个 option 必须有 `label` 和 `description`

---

### 链路 8：上下文清理链路

```
on("context") hook 在每次构建 LLM 上下文时触发：
1. 过滤 PLAN_CONTEXT_MESSAGE_TYPE ("plan-mode-context") 的遗留消息
2. 若 Plan Mode 激活 → 仅清理遗留上下文
3. 若 Plan Mode 未激活 → 额外过滤 PROPOSED_PLAN_MESSAGE_TYPE 消息
   + stripProposedPlanBlocks 清除消息中的 <proposed_plan> 块
```

**stripProposedPlanBlocks** 支持两种消息格式：
- 纯文本消息 → 正则移除 `<proposed_plan>...</proposed_plan>`
- 结构化消息（`{type: "text", text: "..."}` 数组）→ 逐块处理

---

## 三、数据流全景图

```
                    ┌─────────────────────────────────┐
                    │         Pi 加载扩展              │
                    │   planMode(pi) 注册全部钩子       │
                    └──────────────┬──────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
     session_start          /plan 命令            --plan flag
     恢复持久化状态      进入/退出/工具选择     直接进入 Plan Mode
              │                    │                    │
              └────────────────────┼────────────────────┘
                                   ▼
                    ┌──────────────────────────┐
                    │   Plan Mode 已激活        │
                    │   ═══════════════════     │
                    │   工具限制 (read-only)     │
                    │   bash 安全过滤           │
                    │   prompt 注入三阶段指导    │
                    └──────────┬───────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
     Agent 探索代码库    plan_mode_question   Agent 分析/提问
     (read/grep/find)    结构化用户提问        (对话式规划)
              │                │                │
              └────────────────┼────────────────┘
                               ▼
                    ┌──────────────────────────┐
                    │  Agent 输出 <proposed_plan> │
                    │  agent_end 检测到 plan     │
                    └──────────┬───────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
         Implement        Stay in Plan       Exit Plan
         退出PM+恢复工具    保留plan继续讨论    丢弃plan退出
              │
              ▼
     ┌─────────────────────┐
     │ 正常 Agent Turn      │
     │ 完整工具集 + 方案文本 │
     │ 进入实现阶段          │
     └─────────────────────┘
```

## 四、关键设计要点

1. **工具恢复机制**：进入 Plan Mode 前通过 `previousTools` 备份原始工具列表，退出时通过 `restoreTools()` 精确恢复，而非硬编码默认值。

2. **双重安全防护**：内置工具层面阻止 `edit`/`write`；Bash 层面通过黑名单+白名单双层正则过滤命令，阻止文件修改、包安装、git 修改等。

3. **状态持久化与 UI 同步**：每次状态变更都执行 `persistState() + updateUi()`，确保用户通过状态栏即可感知当前所处阶段。

4. **异步延迟执行**：`scheduleAfterCurrentAgentRun` 使用 `setTimeout(0)` 确保 proposed_plan 检测逻辑在当前 agent run 完全结束后执行，避免竞态。

5. **工具选择器用户自治**：非内置扩展工具由用户自行评估风险后启用，模块不做假设性安全判断。

6. **上下文卫生**：通过 `on("context")` 钩子清理 Plan Mode 相关 artifact，避免在非 Plan Mode 会话中残留 `<proposed_plan>` 或元数据消息。