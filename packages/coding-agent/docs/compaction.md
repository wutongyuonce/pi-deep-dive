# 压缩与分支摘要

LLM 的上下文窗口有限。当对话变得过长时，pi 使用压缩来总结较旧的内容，同时保留近期的工作。本页涵盖自动压缩和分支摘要。

**源文件** ([pi-mono](https://github.com/earendil-works/pi-mono)):
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) - 自动压缩逻辑
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) - 分支摘要
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/compaction/utils.ts) - 共享工具（文件追踪、序列化）
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts) - 记录类型（`CompactionEntry`、`BranchSummaryEntry`）
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts) - 扩展事件类型

如需在你的项目中使用 TypeScript 定义，请查看 `node_modules/@earendil-works/pi-coding-agent/dist/`。

## 概述

Pi 有两种摘要机制：

| 机制 | 触发条件 | 目的 |
|-----------|---------|---------|
| 压缩 | 上下文超过阈值，或 `/compact` | 总结旧消息以释放上下文 |
| 分支摘要 | `/tree` 导航 | 切换分支时保留上下文 |

两者使用相同的结构化摘要格式，并累积追踪文件操作。

## 压缩

### 触发时机

自动压缩在以下条件满足时触发：

```
contextTokens > contextWindow - reserveTokens
```

默认情况下，`reserveTokens` 为 16384 个 token（可在 `~/.pi/agent/settings.json` 或 `<项目目录>/.pi/settings.json` 中配置）。这为 LLM 的响应留出空间。

你也可以使用 `/compact [指令]` 手动触发，其中可选的指令用于聚焦摘要内容。

### 工作方式

1. **寻找切分点**：从最新消息开始向前遍历，累积 token 估算值，直到达到 `keepRecentTokens`（默认 20k，可在 `~/.pi/agent/settings.json` 或 `<项目目录>/.pi/settings.json` 中配置）
2. **提取消息**：收集从上一个保留边界（或会话开始）到切分点之间的消息
3. **生成摘要**：调用 LLM 以结构化格式生成摘要，如有之前的摘要则将其作为迭代上下文传入
4. **追加记录**：保存包含摘要和 `firstKeptEntryId` 的 `CompactionEntry`
5. **重新加载**：会话重新加载，使用摘要 + 从 `firstKeptEntryId` 开始的消息

```
压缩前：

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
              待总结的消息                    保留的消息
                                   ↑
                          firstKeptEntryId (entry 4)

压缩后（追加了新记录）：

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 不发送给 LLM                        发送给 LLM
                                                         ↑
                                              从 firstKeptEntryId 开始

LLM 看到的内容：

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   来自 cmp        从 firstKeptEntryId 开始的消息
```

在重复压缩时，被总结的范围从前一次压缩的保留边界（`firstKeptEntryId`）开始，而非从压缩记录本身开始；如果该保留记录在路径中无法找到，则回退到前一次压缩之后的那条记录。这样可以确保在前一次压缩中幸存的消息被包含在下一轮摘要中。Pi 还会在写入新的 `CompactionEntry` 之前，根据重建的会话上下文重新计算 `tokensBefore`，因此 token 计数反映的是被替换的实际压缩前上下文。

### 分割轮次

一个"轮次"以用户消息开始，包含所有助手响应和工具调用，直到下一条用户消息。通常，压缩会在轮次边界处切分。

当单个轮次超过 `keepRecentTokens` 时，切分点会落在轮次中间的助手消息处。这就是"分割轮次"：

```
分割轮次（一个巨大轮次超出预算）：

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (之前没有完整轮次)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

对于分割轮次，pi 会生成两个摘要然后合并：
1. **历史摘要**：之前的上下文（如果有）
2. **轮次前缀摘要**：分割轮次的前半部分

### 切分点规则

有效的切分点包括：
- 用户消息
- 助手消息
- BashExecution 消息
- 自定义消息（custom_message、branch_summary）

绝不在工具结果处切分（它们必须与其工具调用保持在一起）。

### CompactionEntry 结构

定义在 [`session-manager.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts) 中：

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  fromHook?: boolean;  // 如果由扩展提供则为 true（遗留字段名）
  details?: T;         // 实现特定的数据
}

// 默认压缩使用此结构作为 details（来自 compaction.ts）：
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

扩展可以在 `details` 中存储任何 JSON 可序列化的数据。默认压缩追踪文件操作，但自定义扩展实现可以使用自己的结构。

有关实现，请参阅 [`prepareCompaction()`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) 和 [`compact()`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts)。

## 分支摘要

### 触发时机

当你使用 `/tree` 导航到不同分支时，pi 会提供选项来总结你即将离开的工作。这将把离开分支的上下文注入到新分支中。

### 工作方式

1. **寻找共同祖先**：旧位置和新位置共享的最深节点
2. **收集记录**：从旧叶子节点回溯到共同祖先
3. **按预算准备**：在 token 预算内包含消息（从最新开始）
4. **生成摘要**：调用 LLM 以结构化格式生成摘要
5. **追加记录**：在导航点保存 `BranchSummaryEntry`

```
导航前的树：

         ┌─ B ─ C ─ D（旧叶子节点，将被放弃）
    A ───┤
         └─ E ─ F（目标位置）

共同祖先：A
需总结的记录：B、C、D

带摘要的导航后：

         ┌─ B ─ C ─ D ─ [B、C、D 的摘要]
    A ───┤
         └─ E ─ F（新叶子节点）
```

### 累积文件追踪

压缩和分支摘要都会累积追踪文件。生成摘要时，pi 从以下来源提取文件操作：
- 被总结消息中的工具调用
- 之前的压缩或分支摘要 `details`（如果有）

这意味着文件追踪会在多次压缩或嵌套的分支摘要中累积，保留完整的读取和修改文件历史。

### BranchSummaryEntry 结构

定义在 [`session-manager.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts) 中：

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  fromId: string;      // 我们导航来源的记录
  fromHook?: boolean;  // 如果由扩展提供则为 true（遗留字段名）
  details?: T;         // 实现特定的数据
}

// 默认分支摘要使用此结构作为 details（来自 branch-summarization.ts）：
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

与压缩相同，扩展可以在 `details` 中存储自定义数据。

有关实现，请参阅 [`collectEntriesForBranchSummary()`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts)、[`prepareBranchEntries()`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) 和 [`generateBranchSummary()`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts)。

## 摘要格式

压缩和分支摘要使用相同的结构化格式：

```markdown
## Goal（目标）
[用户试图完成什么]

## Constraints & Preferences（约束与偏好）
- [用户提到的需求]

## Progress（进展）
### Done（已完成）
- [x] [已完成的任务]

### In Progress（进行中）
- [ ] [当前工作]

### Blocked（受阻）
- [问题，如果有]

## Key Decisions（关键决策）
- **[决策]**：[理由]

## Next Steps（后续步骤）
1. [接下来应该做什么]

## Critical Context（关键上下文）
- [继续所需的数据]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### 消息序列化

在摘要之前，消息通过 [`serializeConversation()`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/compaction/utils.ts) 序列化为文本：

```
[User]: 用户说的内容
[Assistant thinking]: 内部推理
[Assistant]: 回复文本
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: 工具输出
```

这样可以防止模型将其视为要继续的对话。

工具结果在序列化时会被截断至 2000 个字符。超出该限制的内容会被替换为一个标记，指示被截断了多少字符。这使摘要请求保持在合理的 token 预算内，因为工具结果（尤其是来自 `read` 和 `bash` 的）通常是上下文大小的最大贡献者。

## 通过扩展自定义摘要

扩展可以拦截并自定义压缩和分支摘要。事件类型定义请参阅 [`extensions/types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts)。

### session_before_compact

在自动压缩或 `/compact` 之前触发。可以取消或提供自定义摘要。请参阅类型文件中的 `SessionBeforeCompactEvent` 和 `CompactionPreparation`。

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, signal } = event;

  // preparation.messagesToSummarize - 要总结的消息
  // preparation.turnPrefixMessages - 分割轮次前缀（如果是 isSplitTurn）
  // preparation.previousSummary - 之前的压缩摘要
  // preparation.fileOps - 提取的文件操作
  // preparation.tokensBefore - 压缩前的上下文 token 数
  // preparation.firstKeptEntryId - 保留消息开始的位置
  // preparation.settings - 压缩设置

  // branchEntries - 当前分支上的所有记录（用于自定义状态）
  // signal - AbortSignal（传递给 LLM 调用）

  // 取消：
  return { cancel: true };

  // 自定义摘要：
  return {
    compaction: {
      summary: "你的摘要...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: { /* 自定义数据 */ },
    }
  };
});
```

#### 将消息转换为文本

要使用你自己的模型生成摘要，请使用 `serializeConversation` 将消息转换为文本：

```typescript
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

pi.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // 将 AgentMessage[] 转换为 Message[]，然后序列化为文本
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // 返回：
  // [User]: 消息文本
  // [Assistant thinking]: 思考内容
  // [Assistant]: 回复文本
  // [Assistant tool calls]: read(path="..."); bash(command="...")
  // [Tool result]: 输出文本

  // 现在发送给你的模型进行摘要
  const summary = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});
```

请参阅 [custom-compaction.ts](../examples/extensions/custom-compaction.ts) 获取使用不同模型的完整示例。

### session_before_tree

在 `/tree` 导航之前触发。无论用户是否选择进行摘要，都会触发。可以取消导航或提供自定义摘要。

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - 导航目标位置
  // preparation.oldLeafId - 当前位置（即将被放弃）
  // preparation.commonAncestorId - 共同祖先
  // preparation.entriesToSummarize - 将被总结的记录
  // preparation.userWantsSummary - 用户是否选择了摘要

  // 完全取消导航：
  return { cancel: true };

  // 提供自定义摘要（仅在 userWantsSummary 为 true 时使用）：
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "你的摘要...",
        details: { /* 自定义数据 */ },
      }
    };
  }
});
```

请参阅类型文件中的 `SessionBeforeTreeEvent` 和 `TreePreparation`。

## 设置

在 `~/.pi/agent/settings.json` 或 `<项目目录>/.pi/settings.json` 中配置压缩：

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

| 设置 | 默认值 | 描述 |
|---------|---------|-------------|
| `enabled` | `true` | 启用自动压缩 |
| `reserveTokens` | `16384` | 为 LLM 响应预留的 token 数 |
| `keepRecentTokens` | `20000` | 保留的近期 token 数（不进行摘要） |

使用 `"enabled": false` 禁用自动压缩。你仍然可以使用 `/compact` 手动压缩。
