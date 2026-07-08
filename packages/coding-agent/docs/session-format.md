# 会话文件格式

会话以 JSONL（JSON Lines）文件形式存储。每行是一个包含 `type` 字段的 JSON 对象。会话条目通过 `id`/`parentId` 字段构成树形结构，支持原地分支而不创建新文件。

## 文件位置

```
~/.pi/agent/sessions/--<路径>--/<时间戳>_<uuid>.jsonl
```

其中 `<路径>` 是工作目录，其中的 `/` 替换为 `-`。

## 删除会话

可以通过删除 `~/.pi/agent/sessions/` 下的 `.jsonl` 文件来移除会话。

Pi 也支持从 `/resume` 交互式删除会话（选择一个会话后按 `Ctrl+D`，然后确认）。当可用时，pi 会使用 `trash` 命令行工具以避免永久删除。

## 会话版本

会话在头部包含版本字段：

- **版本 1**：线性条目序列（旧版，加载时自动迁移）
- **版本 2**：使用 `id`/`parentId` 连接的树形结构
- **版本 3**：将 `hookMessage` 角色重命名为 `custom`（扩展统一）

现有会话在加载时会自动迁移到当前版本（v3）。

## 源文件

GitHub 源码（[pi-mono](https://github.com/earendil-works/pi-mono)）：
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts) - 会话条目类型和 SessionManager
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/messages.ts) - 扩展消息类型（BashExecutionMessage、CustomMessage 等）
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/types.ts) - 基础消息类型（UserMessage、AssistantMessage、ToolResultMessage）
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/agent/src/types.ts) - AgentMessage 联合类型

如需在你的项目中使用 TypeScript 类型定义，请查看 `node_modules/@earendil-works/pi-coding-agent/dist/` 和 `node_modules/@earendil-works/pi-ai/dist/`。

## 消息类型

会话条目包含 `AgentMessage` 对象。理解这些类型对于解析会话和编写扩展至关重要。

### 内容块

消息包含类型化的内容块数组：

```typescript
interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;      // base64 编码
  mimeType: string;  // 例如 "image/jpeg"、"image/png"
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}
```

### 基础消息类型（来自 pi-ai）

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix 毫秒
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: any;      // 工具特定的元数据
  isError: boolean;
  timestamp: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

### 扩展消息类型（来自 pi-coding-agent）

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // 对于 !! 前缀命令为 true
  timestamp: number;
}

interface CustomMessage {
  role: "custom";
  customType: string;            // 扩展标识符
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // 是否在 TUI 中显示
  details?: any;                 // 扩展特定的元数据
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;                // 分支来源的条目
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

### AgentMessage 联合类型

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

## 条目基础

所有条目（`SessionHeader` 除外）都继承 `SessionEntryBase`：

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // 8 字符十六进制 ID
  parentId: string | null;  // 父条目 ID（首个条目为 null）
  timestamp: string;    // ISO 时间戳
}
```

## 条目类型

### SessionHeader

文件的第一行。仅包含元数据，不参与树结构（无 `id`/`parentId`）。

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

对于有父会话的会话（通过 `/fork`、`/clone` 或 `newSession({ parentSession })` 创建）：

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### SessionMessageEntry

对话中的一条消息。`message` 字段包含一个 `AgentMessage`。

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop"}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false}}
```

### ModelChangeEntry

当用户在会话中途切换模型时产生。

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

当用户更改思考/推理级别时产生。

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### CompactionEntry

当上下文被压缩时创建。存储早期消息的摘要。

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"用户讨论了 X、Y、Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000}
```

可选字段：
- `details`：实现特定的数据（例如，默认情况下为 `{ readFiles: string[], modifiedFiles: string[] }`，或扩展的自定义数据）
- `fromHook`：如果由扩展生成则为 `true`，pi 生成的则为 `false`/`undefined`（旧字段名）

### BranchSummaryEntry

通过 `/tree` 切换分支时创建，包含 LLM 生成的分支摘要（从当前分支回溯到共同祖先）。捕获已放弃路径的上下文。

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"分支探索了方案 A..."}
```

可选字段：
- `details`：文件跟踪数据（默认情况下为 `{ readFiles: string[], modifiedFiles: string[] }`，或扩展的自定义数据）
- `fromHook`：如果由扩展生成则为 `true`，pi 生成的则为 `false`/`undefined`（旧字段名）

### CustomEntry

扩展状态持久化。**不参与** LLM 上下文。

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

使用 `customType` 在重新加载时识别你的扩展条目。

### CustomMessageEntry

扩展注入的消息，**参与** LLM 上下文。

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"注入的上下文...","display":true}
```

字段：
- `content`：字符串或 `(TextContent | ImageContent)[]`（与 UserMessage 相同）
- `display`：`true` = 在 TUI 中显示（使用不同的样式），`false` = 隐藏
- `details`：可选的扩展特定元数据（不发送给 LLM）

### LabelEntry

用户定义的条目标签/标记。

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

将 `label` 设为 `undefined` 可清除标签。

### SessionInfoEntry

会话元数据（例如，用户定义的显示名称）。通过 `/name` 命令或扩展中的 `pi.setSessionName()` 设置。

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"重构认证模块"}
```

设置后，会话名称会显示在会话选择器（`/resume`）中，替代第一条消息。

## 树形结构

条目构成一棵树：
- 第一个条目的 `parentId` 为 `null`
- 每个后续条目通过 `parentId` 指向其父条目
- 分支从较早的条目创建新的子条目
- "叶子"节点是树中的当前位置

```
[用户消息] ─── [助手] ─── [用户消息] ─── [助手] ─┬─ [用户消息] ← 当前叶子
                                                   │
                                                   └─ [分支摘要] ─── [用户消息] ← 另一分支
```

## 上下文构建

`buildSessionContext()` 从当前叶子节点向根节点遍历，生成供 LLM 使用的消息列表：

1. 收集路径上的所有条目
2. 提取当前模型和思考级别设置
3. 如果路径上存在 `CompactionEntry`：
   - 先输出摘要
   - 然后输出从 `firstKeptEntryId` 到压缩点的消息
   - 然后输出压缩点之后的消息
4. 将 `BranchSummaryEntry` 和 `CustomMessageEntry` 转换为适当的消息格式

## 解析示例

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`会话 v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] 压缩: ${entry.tokensBefore} tokens 已汇总`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] 从 ${entry.fromId} 分支`);
      break;
    case "custom":
      console.log(`[${entry.id}] 自定义 (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] 扩展消息 (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] 标签 "${entry.label}" 在 ${entry.targetId} 上`);
      break;
    case "model_change":
      console.log(`[${entry.id}] 模型: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] 思考级别: ${entry.thinkingLevel}`);
      break;
  }
}
```

## SessionManager API

用于以编程方式操作会话的关键方法。

### 静态创建方法
- `SessionManager.create(cwd, sessionDir?)` - 新建会话
- `SessionManager.open(path, sessionDir?)` - 打开现有会话文件
- `SessionManager.continueRecent(cwd, sessionDir?)` - 继续最近的会话或创建新会话
- `SessionManager.inMemory(cwd?)` - 无文件持久化
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)` - 从另一个项目 fork 会话

### 静态列表方法
- `SessionManager.list(cwd, sessionDir?, onProgress?)` - 列出某个目录的会话
- `SessionManager.listAll(onProgress?)` - 列出所有项目的所有会话

### 实例方法 - 会话管理
- `newSession(options?)` - 开始新会话（options: `{ parentSession?: string }`）
- `setSessionFile(path)` - 切换到不同的会话文件
- `createBranchedSession(leafId)` - 将分支提取到新的会话文件

### 实例方法 - 追加（均返回条目 ID）
- `appendMessage(message)` - 添加消息
- `appendThinkingLevelChange(level)` - 记录思考级别变更
- `appendModelChange(provider, modelId)` - 记录模型变更
- `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?)` - 添加压缩
- `appendCustomEntry(customType, data?)` - 扩展状态（不在上下文中）
- `appendSessionInfo(name)` - 设置会话显示名称
- `appendCustomMessageEntry(customType, content, display, details?)` - 扩展消息（在上下文中）
- `appendLabelChange(targetId, label)` - 设置/清除标签

### 实例方法 - 树导航
- `getLeafId()` - 当前位置
- `getLeafEntry()` - 获取当前叶子条目
- `getEntry(id)` - 根据 ID 获取条目
- `getBranch(fromId?)` - 从条目遍历到根节点
- `getTree()` - 获取完整树结构
- `getChildren(parentId)` - 获取直接子条目
- `getLabel(id)` - 获取条目的标签
- `branch(entryId)` - 将叶子移动到较早的条目
- `resetLeaf()` - 将叶子重置为 null（在任何条目之前）
- `branchWithSummary(entryId, summary, details?, fromHook?)` - 带上下文摘要的分支

### 实例方法 - 上下文与信息
- `buildSessionContext()` - 获取供 LLM 使用的消息、thinkingLevel 和 model
- `getEntries()` - 所有条目（不包括头部）
- `getHeader()` - 会话头部元数据
- `getSessionName()` - 从最新的 session_info 条目获取显示名称
- `getCwd()` - 工作目录
- `getSessionDir()` - 会话存储目录
- `getSessionId()` - 会话 UUID
- `getSessionFile()` - 会话文件路径（内存模式下为 undefined）
- `isPersisted()` - 会话是否已保存到磁盘
