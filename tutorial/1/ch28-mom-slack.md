# 第 28 章：`mom` — Slack 里的 Coding Agent

> **定位**：本章展示 pi 内核在 Slack bot 产品中的复用方式。
> 前置依赖：第 11 章（会话管理）、第 22 章（bash 工具）。
> 适用场景：当你想理解"同一个 agent 内核，不同的产品壳"在实践中是什么样。

## 从终端到 Slack：同一个内核，不同的壳

pi CLI 是终端里的 coding agent。mom 是 Slack 里的 coding agent。两者共享同一个内核（pi-ai + pi-agent-core），但产品形态完全不同：

| 维度 | pi CLI | mom |
|------|--------|-----|
| 用户交互 | 终端 TUI | Slack 消息 |
| 会话生命周期 | 按工作目录 | 按 channel |
| 工具执行 | 本地进程 | Docker 容器或 host |
| 输出展示 | 富文本终端 | Slack mrkdwn + 线程 |
| 多用户 | 单用户 | 多用户多频道 |

mom 的源码总量约 4000 行（含工具），核心在于如何把 pi-coding-agent 的 `AgentSession` 适配到 Slack 的消息模型中。

## AgentRunner：channel 级的 agent 实例

mom 的核心抽象是 `AgentRunner` — 每个 Slack channel 有一个独立的 runner 实例，缓存在内存中：

```typescript
// packages/mom/src/agent.ts:392-405
const channelRunners = new Map<string, AgentRunner>();

export function getOrCreateRunner(
  sandboxConfig: SandboxConfig,
  channelId: string,
  channelDir: string
): AgentRunner {
  const existing = channelRunners.get(channelId);
  if (existing) return existing;

  const runner = createRunner(sandboxConfig, channelId, channelDir);
  channelRunners.set(channelId, runner);
  return runner;
}
```

`AgentRunner` 接口很简洁 — 只有 `run()` 和 `abort()` 两个方法。但 `createRunner()` 内部做了大量的适配工作。

### 复用 AgentSession

mom 最重要的设计决策是**直接复用 pi-coding-agent 的 `AgentSession`**，而不是自己实现会话管理。看 `createRunner()` 的核心结构：

```typescript
// packages/mom/src/agent.ts:435-476
// 创建 Agent（pi-agent-core 层）
const agent = new Agent({
  initialState: { systemPrompt, model, thinkingLevel: "off", tools },
  convertToLlm,
  getApiKey: async () => getAnthropicApiKey(authStorage),
});

// 创建 SessionManager（pi-coding-agent 层）
const contextFile = join(channelDir, "context.jsonl");
const sessionManager = SessionManager.open(contextFile, channelDir);
const settingsManager = createMomSettingsManager(join(channelDir, ".."));

// 组装 AgentSession（pi-coding-agent 层）
const session = new AgentSession({
  agent,
  sessionManager,
  settingsManager,
  cwd: process.cwd(),
  modelRegistry,
  resourceLoader,
  baseToolsOverride,
});
```

这里的关键：mom 使用了 `AgentSession` 的全部能力 — 会话持久化、自动 compaction、消息同步 — 但替换了 UI 层（用 Slack API 代替 TUI）和工具集（用 mom 专属工具代替通用工具）。

`resourceLoader` 是一个最小实现，因为 mom 不需要 extension 加载、theme 等 CLI 专属功能：

```typescript
// packages/mom/src/agent.ts:453-463
const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [],
    runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => systemPrompt,
  getAppendSystemPrompt: () => [],
  extendResources: () => {},
  reload: async () => {},
};
```

这就是"协议式设计"的回报 — `AgentSession` 不关心谁提供 resource，只要实现接口就行。

## Channel 级数据隔离

mom 把每个 Slack channel 视为一个独立的 agent 工作空间：

```
~/.pi/mom/data/
├── MEMORY.md                 # 全局记忆
├── settings.json             # 全局设置
├── events/                   # 事件调度文件
├── skills/                   # 全局 skills
├── C123ABC/                  # Channel A
│   ├── MEMORY.md             # Channel 级记忆
│   ├── log.jsonl             # 完整消息历史
│   ├── context.jsonl         # LLM context
│   ├── skills/               # Channel 级 skills
│   ├── attachments/          # 用户上传的文件
│   └── scratch/              # 工作目录
└── C456DEF/                  # Channel B
    └── ...                   # 完全独立的数据
```

每个 channel 有独立的记忆、历史、skills 和工作目录。agent 在 Channel A 中的操作不会影响 Channel B。

### 双层记忆系统

mom 的记忆分为全局和 channel 两级。`getMemory()` 函数按层级组装：

```typescript
// packages/mom/src/agent.ts:69-103
function getMemory(channelDir: string): string {
  const parts: string[] = [];

  // 全局记忆（跨所有 channel 共享）
  const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
  if (existsSync(workspaceMemoryPath)) {
    const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
    if (content) {
      parts.push(`### Global Workspace Memory\n${content}`);
    }
  }

  // Channel 级记忆
  const channelMemoryPath = join(channelDir, "MEMORY.md");
  if (existsSync(channelMemoryPath)) {
    const content = readFileSync(channelMemoryPath, "utf-8").trim();
    if (content) {
      parts.push(`### Channel-Specific Memory\n${content}`);
    }
  }

  return parts.length === 0 ? "(no working memory yet)" : parts.join("\n\n");
}
```

全局记忆存放跨频道的信息（用户偏好、项目知识），channel 记忆存放频道特定的上下文（正在进行的任务、频道约定）。agent 可以通过 bash 工具直接编辑这些 MEMORY.md 文件。

### 双层 Skill 系统

Skills 也分为全局和 channel 两级，channel 级 skill 可以覆盖同名的全局 skill：

```typescript
// packages/mom/src/agent.ts:105-139
function loadMomSkills(channelDir: string, workspacePath: string): Skill[] {
  const skillMap = new Map<string, Skill>();

  // 加载全局 skills
  const workspaceSkillsDir = join(hostWorkspacePath, "skills");
  for (const skill of loadSkillsFromDir({
    dir: workspaceSkillsDir, source: "workspace"
  }).skills) {
    skillMap.set(skill.name, skill);
  }

  // 加载 channel 级 skills（同名覆盖全局）
  const channelSkillsDir = join(channelDir, "skills");
  for (const skill of loadSkillsFromDir({
    dir: channelSkillsDir, source: "channel"
  }).skills) {
    skillMap.set(skill.name, skill);  // Map 覆盖语义
  }

  return Array.from(skillMap.values());
}
```

这让不同 channel 可以展示不同的"人格"。例如，一个 channel 专注于代码审查，另一个 channel 专注于运维监控 — 通过不同的 skills 引导 agent 的行为。

## Slack Socket Mode 集成

mom 使用 Slack 的 Socket Mode（WebSocket）而非 HTTP webhook，避免了需要公网可达的 endpoint。核心类型定义展示了 Slack 的消息模型：

```typescript
// packages/mom/src/slack.ts:1-66
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

export interface SlackContext {
  message: {
    text: string;
    rawText: string;
    user: string;
    userName?: string;
    channel: string;
    ts: string;
    attachments: Array<{ local: string }>;
  };
  channelName?: string;
  channels: ChannelInfo[];
  users: UserInfo[];
  respond: (text: string, shouldLog?: boolean) => Promise<void>;
  replaceMessage: (text: string) => Promise<void>;
  respondInThread: (text: string) => Promise<void>;
  uploadFile: (filePath: string, title?: string) => Promise<void>;
  deleteMessage: () => Promise<void>;
}
```

`SlackContext` 封装了 Slack API 的操作集合 — `respond` 回复主消息、`respondInThread` 回复线程、`replaceMessage` 更新已发送的消息、`uploadFile` 上传文件。这些操作被传入 `AgentRunner.run()`，由事件处理器在 agent 执行过程中调用。

## 线程化工具输出

Slack 的消息限制约束了交互设计。mom 的解决方案是**主消息展示最终结果，线程展示工具执行过程**。

事件订阅代码（只在 runner 创建时注册一次）处理每个 agent 事件：

```typescript
// packages/mom/src/agent.ts:505-544
if (event.type === "tool_execution_start") {
  // 主消息：显示工具 label（如"Reading file..."）
  queue.enqueue(
    () => ctx.respond(`_→ ${label}_`, false), "tool label"
  );
} else if (event.type === "tool_execution_end") {
  // 线程：显示工具的完整参数和结果
  let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${
    agentEvent.toolName}*`;
  if (label) threadMessage += `: ${label}`;
  threadMessage += ` (${duration}s)\n`;
  if (argsFormatted)
    threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
  threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;

  queue.enqueueMessage(
    threadMessage, "thread", "tool result thread", false
  );
}
```

设计要点：

1. **主消息保持简洁**。只显示 `_→ Reading file..._` 这样的斜体标签，不显示完整的工具参数和结果
2. **线程记录完整上下文**。工具名、参数、执行时间、完整结果都在线程中可查
3. **错误额外提示**。工具失败时，除了线程记录外，主消息也会显示截断的错误信息
4. **消息队列保证顺序**。所有 Slack API 调用通过 `queue.enqueue()` 串行化，避免乱序

### 消息长度处理

Slack 有 40000 字符的消息长度限制。mom 通过 `splitForSlack` 自动分割长消息：

```typescript
// packages/mom/src/agent.ts:623-637
const SLACK_MAX_LENGTH = 40000;
const splitForSlack = (text: string): string[] => {
  if (text.length <= SLACK_MAX_LENGTH) return [text];
  const parts: string[] = [];
  let remaining = text;
  let partNum = 1;
  while (remaining.length > 0) {
    const chunk = remaining.substring(0, SLACK_MAX_LENGTH - 50);
    remaining = remaining.substring(SLACK_MAX_LENGTH - 50);
    const suffix = remaining.length > 0
      ? `\n_(continued ${partNum}...)_` : "";
    parts.push(chunk + suffix);
    partNum++;
  }
  return parts;
};
```

## Docker Sandbox 实现

mom 的推荐部署方式是 Docker sandbox — 所有 bash 命令在容器中执行，限制了 agent 的文件系统访问。

sandbox 的抽象层很薄，只有一个 `Executor` 接口：

```typescript
// packages/mom/src/sandbox.ts:79-91
export interface Executor {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  getWorkspacePath(hostPath: string): string;
}
```

两个实现：

```typescript
// packages/mom/src/sandbox.ts:104-193
class HostExecutor implements Executor {
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    // 直接在 host 上执行 sh -c command
    const child = spawn(shell, [...shellArgs, command], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    // ... timeout + abort signal 处理
  }
  getWorkspacePath(hostPath: string): string {
    return hostPath;  // host 路径不需要转换
  }
}

class DockerExecutor implements Executor {
  constructor(private container: string) {}
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    // 包装为 docker exec container sh -c 'command'
    const dockerCmd = `docker exec ${this.container} sh -c ${
      shellEscape(command)}`;
    const hostExecutor = new HostExecutor();
    return hostExecutor.exec(dockerCmd, options);
  }
  getWorkspacePath(_hostPath: string): string {
    return "/workspace";  // 容器内统一为 /workspace
  }
}
```

`DockerExecutor` 的实现是委托模式 — 它把命令包装成 `docker exec`，然后交给 `HostExecutor` 执行。关键的安全边界在于：

1. **路径隔离**。容器内只看到 `/workspace`（挂载的数据目录），看不到 host 文件系统
2. **路径转换**。`getWorkspacePath()` 把 host 路径转为容器路径；`translateToHostPath()` 做反向转换（用于文件上传）
3. **启动前验证**。`validateSandbox()` 检查 Docker 可用性和容器运行状态

## 上下文同步：log.jsonl 与 context.jsonl

mom 面临一个独特的挑战：Slack 消息可能在 agent 不在线时到达。`context.ts` 中的 `syncLogToSessionManager` 解决这个问题：

```typescript
// packages/mom/src/context.ts:42-46
// 确保 agent 离线期间的消息被同步到 LLM context
export function syncLogToSessionManager(
  sessionManager: SessionManager,
  channelDir: string,
  excludeSlackTs?: string,  // 排除当前正在处理的消息
): number
```

同步逻辑：
1. 从 `log.jsonl` 读取所有用户消息
2. 与 `context.jsonl`（SessionManager）中已有的消息做去重比对
3. 只添加 context 中不存在的消息
4. 跳过 bot 消息（agent 的回复已通过正常流程记录）
5. 排除当前正在处理的消息（避免重复）

去重用**消息文本归一化**实现 — 剥离时间戳前缀和附件部分后比较内容。

## 事件调度系统

mom 不只是被动响应消息。它有一个事件调度系统，让 agent 可以自己安排"闹钟"：

```typescript
// packages/mom/src/events.ts:12-33
export interface ImmediateEvent {
  type: "immediate";
  channelId: string;
  text: string;
}

export interface OneShotEvent {
  type: "one-shot";
  channelId: string;
  text: string;
  at: string;  // ISO 8601 时间
}

export interface PeriodicEvent {
  type: "periodic";
  channelId: string;
  text: string;
  schedule: string;  // cron 语法
  timezone: string;  // IANA 时区
}
```

三种事件类型覆盖了不同场景：

- **Immediate**：脚本或 webhook 触发的即时事件（"新 GitHub issue 开了"）
- **One-shot**：定时提醒（"下午 3 点提醒开会"）
- **Periodic**：定期任务（"每天早上 9 点检查邮箱"）

事件以 JSON 文件形式存放在 `events/` 目录中。`EventsWatcher` 用 `fs.watch` 监控目录变化，用 `croner` 库处理 cron 调度。agent 自己可以通过 bash 工具创建事件文件 — 这是一个优雅的自举设计：agent 的"安排未来行动"能力不需要专门的 API，只需要写文件。

periodic 事件还支持 `[SILENT]` 标记 — 如果定期检查发现没有可报告的内容，agent 回复 `[SILENT]`，mom 会删除状态消息，避免刷屏。

## System Prompt 的动态装配

每次 `run()` 执行时，mom 都会重新构建 system prompt，注入最新的：
- 当前 memory 内容
- Slack workspace 的 channel 和 user 列表（带 ID 映射）
- 当前加载的 skills
- sandbox 环境描述（Docker 还是 host）
- 事件系统的使用说明和 cron 格式参考

system prompt 约 300 行，是 mom 最长的单个代码块。它本质上是一份完整的"操作手册"，告诉 agent 它是谁、在什么环境中、能做什么。

## 取舍分析

### 得到了什么

**安全的多租户**。Docker sandbox 限制了 agent 的文件系统访问。channel 级数据隔离防止了跨频道的信息泄露。双层记忆和 skill 系统让不同频道可以有不同的"人格"。

**内核复用零修改**。mom 没有 fork 或修改 pi-agent-core 或 pi-coding-agent 的任何代码。它通过实现接口（`ResourceLoader`、`Executor`）和订阅事件来适配。这证明了第 30 章所说的"协议式设计"的可行性。

**自主调度能力**。事件系统让 mom 从被动的"问答机器人"进化为主动的"助手" — 它可以定时检查邮箱、监控系统状态、提醒待办事项。

### 放弃了什么

**Slack 的消息限制约束了交互设计**。Slack 消息有字符数限制、不支持复杂的交互组件。mom 通过线程回复来展示详细的工具输出，但体验不如终端 TUI 的实时流式渲染。

**单 channel 串行执行**。每个 channel 同一时间只处理一条消息。其他消息排队等待或被记录到 log.jsonl 中待后续同步。这是有意的简化 — 避免并发导致的 context 冲突。

**缺少同步确认流**。pi 的核心并不内建 permission popup；即便某个 CLI 产品壳选择实现确认流，这种同步交互也很难直接搬到 Slack。mom 的安全策略主要依赖 Docker sandbox 的隔离，而不是运行时审批。

---

### 版本演化说明
> 本章核心分析基于 pi-mono v0.66.0。Mom 的 channel 级 skills 和 memory
> 是近期添加的，让 mom 可以在不同频道展示不同的"人格"。事件调度系统
> 也是后期添加的能力，使 mom 从被动响应进化为主动助手。
