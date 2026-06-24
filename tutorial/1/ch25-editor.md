# 第 25 章：编辑器组件 — 交互复杂度的集中地

> **定位**：本章解析 pi 的编辑器组件为什么代码量超过很多独立项目。
> 前置依赖：第 24 章（pi-tui 框架）。
> 适用场景：当你想理解终端交互的真实复杂度。

## 为什么编辑器这么复杂？

pi 的 Editor 组件处理的不只是"输入文字"：

- **多行编辑**：`Shift+Enter` / `Ctrl+Enter` 换行（取决于终端能力）
- **`@` 文件引用**：输入 `@` 触发模糊文件搜索，选中后附加为上下文
- **`!command` 执行**：输入 `!` 前缀运行 bash，输出送入 LLM
- **`Tab` 路径补全**：自动补全文件路径和斜杠命令
- **图片粘贴**：`Ctrl+V` 检测剪贴板中的图片
- **滚动与光标**：长输入的垂直滚动和光标管理

每个功能单独看都不复杂。但组合在一起 — 用户在多行编辑中间触发了 `@` 搜索，搜索结果弹出覆盖层，用户按 Tab 选中文件，覆盖层关闭，光标回到编辑位置 — 这些状态转换的组合爆炸是编辑器代码量大的根本原因。

## Editor 类结构

```typescript
// packages/tui/src/components/editor.ts:217
export class Editor implements Component, Focusable {
  // ... 核心编辑状态 ...
  private autocompleteProvider?: AutocompleteProvider;
  private autocompleteList?: SelectList;
  private autocompleteState: "regular" | "force" | null = null;
  private autocompletePrefix: string = "";
  private autocompleteMaxVisible: number = 5;
  private autocompleteAbort?: AbortController;
  private autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
  private autocompleteRequestTask: Promise<void> =
    Promise.resolve();
  private autocompleteStartToken: number = 0;
  private autocompleteRequestId: number = 0;

  // Paste tracking for large pastes
  private pastes: Map<number, string> = new Map();
  private pasteCounter: number = 0;
  private pasteBuffer: string = "";
  // ...
}
```

光是自动补全相关的字段就有 10 个。这不是过度设计 — 每个字段都解决一个真实的并发问题：

- `autocompleteAbort`：取消正在进行的补全请求（用户继续输入时需要取消旧请求）
- `autocompleteDebounceTimer`：防抖，用户快速输入时不触发每一个字符的补全
- `autocompleteRequestId`：请求序号，确保过时的异步响应不会覆盖新的结果
- `autocompleteStartToken`：记录补全开始时的光标位置，用于在完成补全时正确替换文本

## 自动补全系统

Editor 的自动补全通过 `AutocompleteProvider` 接口和外部系统对接：

```typescript
// packages/tui/src/autocomplete.ts (接口定义)
export interface AutocompleteProvider {
  getSuggestions(
    text: string,
    cursorPosition: number,
    signal: AbortSignal,
  ): Promise<AutocompleteSuggestions | null>;
}
```

补全触发有两种模式：

- **`"regular"`**：用户输入时自动触发（带 debounce），比如输入 `/` 后提示斜杠命令
- **`"force"`**：用户按 Tab 明确请求补全

补全请求是异步的 — 文件路径补全可能需要扫描文件系统，斜杠命令补全可能需要查询已注册的命令列表。异步意味着竞态条件：用户发起补全请求后继续输入，旧请求的结果到达时上下文已经变化。

`autocompleteRequestId` 解决这个问题：每次发起请求时递增 ID，响应到达时检查 ID 是否匹配当前请求。不匹配的响应被静默丢弃。这比 debounce 更精确 — debounce 只能延迟请求，但不能处理"请求已发出、响应延迟到达"的情况。

补全列表使用 `SelectList` 组件渲染，通过 overlay 系统（第 24 章）定位在光标下方。最多显示 5 项（`autocompleteMaxVisible`），可以通过配置调整：

```typescript
// packages/tui/src/components/editor.ts:287-288
const maxVisible = options.autocompleteMaxVisible ?? 5;
this.autocompleteMaxVisible = Number.isFinite(maxVisible)
  ? Math.max(3, Math.min(20, Math.floor(maxVisible)))
  : 5;
```

## `@` 文件引用

输入 `@` 触发文件搜索覆盖层。这和普通的自动补全不同 — 它弹出一个独立的搜索界面，支持模糊匹配，选中后在消息中插入文件引用标记。

工作流程：

1. 用户输入 `@`，Editor 检测到这是文件引用触发字符
2. 弹出文件搜索 overlay（使用 find 工具的后端逻辑扫描项目文件）
3. 用户继续输入缩小搜索范围，搜索结果实时更新
4. 用户按 Enter 选中文件，overlay 关闭
5. 文件路径作为上下文附加到消息中（不是插入文本 — 而是作为 context attachment）

这个流程的关键设计是：文件引用不是文本替换，而是结构化数据。LLM 收到的不是 `@src/foo.ts` 这样的字符串，而是一个包含文件路径的 context 对象。这让后端可以把文件内容读出来作为附加上下文发送给 LLM。

## `!` Bash 执行

以 `!` 开头的消息触发 bash 执行模式：

- `!npm test` — 执行命令，输出作为用户消息的一部分发送给 LLM
- `!!` — 重复上一条 bash 命令

这个功能把编辑器变成了一个混合输入界面 — 既是聊天输入框，也是命令行。用户不需要切换到单独的终端窗口就能运行命令并把结果分享给 LLM。

## 粘贴处理

粘贴在终端中比在浏览器中复杂得多。Editor 需要处理多种场景：

### Bracketed Paste Mode

现代终端支持 bracketed paste — 在粘贴内容前后加入标记序列（`\x1b[200~` 和 `\x1b[201~`），让应用区分"用户输入"和"粘贴内容"。Editor 检测到 bracketed paste 开始标记后，把后续输入缓存到 `pasteBuffer` 中，直到结束标记。

```typescript
// packages/tui/src/components/editor.ts:252-257
// Paste tracking for large pastes
private pastes: Map<number, string> = new Map();
private pasteCounter: number = 0;

// Bracketed paste mode buffering
private pasteBuffer: string = "";
```

### 大文本粘贴折叠

用户可能粘贴几百行的日志或代码。如果直接显示在编辑器中，会让输入区域变得巨大。Editor 的解决方案是 **paste marker**：

```typescript
// packages/tui/src/components/editor.ts:12-16
const PASTE_MARKER_REGEX =
  /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
const PASTE_MARKER_SINGLE =
  /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;
```

大粘贴被替换为一个标记如 `[paste #1 +123 lines]`，原始内容保存在 `pastes` Map 中。这个标记在编辑器中作为一个原子单元处理 — 光标移动跳过它，删除时整体删除。

`segmentWithMarkers` 函数包装了 `Intl.Segmenter`，让 paste marker 在 Unicode 分词层面也表现为单个 segment：

```typescript
// packages/tui/src/components/editor.ts:30-45
function segmentWithMarkers(
  text: string, validIds: Set<number>
): Iterable<Intl.SegmentData> {
  if (validIds.size === 0 || !text.includes("[paste #")) {
    return baseSegmenter.segment(text);
  }
  // Find all marker spans with valid IDs
  // Merge graphemes within markers into single segments
  // ...
}
```

这个实现的精巧之处：paste marker 的存在对 word wrap、光标移动、删除操作都是透明的 — 因为它们在分词层就被处理成了原子单元。

## IME 支持

IME（Input Method Editor）是中日韩文输入的基础设施。终端中的 IME 支持比 GUI 应用困难得多：

1. **光标定位**。IME 的候选窗口需要显示在光标附近。Editor 在 `render()` 输出中嵌入 `CURSOR_MARKER`，TUI 提取位置后设置硬件光标，IME 读取硬件光标位置来定位候选窗口。

2. **compose 事件**。IME 的输入过程是多步的 — 用户按下拼音字母，IME 在 compose 状态下显示拼音，用户选择候选字后 IME 发送最终字符。Editor 需要正确处理这个 compose 过程，不能把中间状态当作最终输入。

3. **Kitty keyboard protocol**。Kitty 终端的增强键盘协议可以区分 keydown 和 keyup，提供更精确的键盘事件。但 IME 在这个协议下的行为和标准模式不同，需要特殊处理。

## Word Wrap 算法

Editor 的 word wrap 不是简单的"按宽度截断"。它需要考虑：

- **Unicode 字符宽度**：CJK 字符宽 2 列，拉丁字符宽 1 列，emoji 可能宽 2 列
- **换行点选择**：优先在空格处换行，其次在标点处换行，最后才强制在字符边界换行
- **Paste marker**：作为原子单元不能被换行拆开（除非宽度超过整行）

```typescript
// packages/tui/src/components/editor.ts:101-108
export function wordWrapLine(
  line: string,
  maxWidth: number,
  preSegmented?: Intl.SegmentData[]
): TextChunk[] {
  if (!line || maxWidth <= 0) {
    return [{ text: "", startIndex: 0, endIndex: 0 }];
  }
  const lineWidth = visibleWidth(line);
  if (lineWidth <= maxWidth) {
    return [{ text: line, startIndex: 0, endIndex: line.length }];
  }
  // ...complex wrapping logic...
}
```

`TextChunk` 不只是文本片段 — 它还记录了在原始行中的起始和结束位置（`startIndex`、`endIndex`）。这让光标在 wrapped 行之间移动时可以正确映射回原始文本位置。

## Kill Ring

Editor 实现了 Emacs 风格的 kill ring — `Ctrl+K` 杀掉光标到行尾的内容，`Ctrl+Y` 粘贴最近 kill 的内容。这不是剪贴板 — 它是一个独立的循环缓冲区，保存了多次 kill 的历史。

为什么要实现 kill ring 而不只是用系统剪贴板？因为在终端中访问系统剪贴板需要 OSC 52 序列支持（不是所有终端都支持），而且 kill ring 和 Emacs 快捷键是终端用户的肌肉记忆。

## Undo Stack

编辑器维护了自己的 undo 栈（`UndoStack`），支持 `Ctrl+Z` 撤销和 `Ctrl+Shift+Z` / `Ctrl+Y` 重做。这在终端编辑器中不是标配 — 大多数终端输入框不支持撤销。但对于多行编辑场景（用户可能编辑一段代码片段作为 prompt），撤销功能从"可选"变成了"必要"。

## 状态转换的复杂性

编辑器在任意时刻可能处于以下状态之一：

1. **普通编辑**：正常文本输入
2. **自动补全**：补全列表可见，上下箭头选择，Enter 确认，Esc 取消
3. **文件搜索**：`@` 触发的搜索 overlay
4. **Compose**：IME 正在组合输入

这些状态之间的转换不是线性的。用户可以在 compose 状态下按 `@`，需要先完成 compose 再进入文件搜索；在自动补全时按 Esc，需要关闭补全但不退出编辑。每种转换都需要正确处理焦点、光标位置、缓冲区内容。

这就是为什么 Editor 是 pi-tui 中代码量最大的组件 — 不是因为单个功能复杂，而是因为功能组合的状态空间是乘法增长的。

## 取舍分析

### 得到了什么

**流畅的交互体验**。用户不需要离开编辑器就能引用文件、执行命令、查看补全。这些快捷方式让 pi 感觉像一个 IDE 而不是一个聊天框。

**大粘贴的优雅处理**。Paste marker 机制让用户可以粘贴大段内容而不破坏编辑器的可用性。

### 放弃了什么

**大量的边界条件**。每种输入方式（键盘、粘贴、IME、Kitty protocol）和每种交互模式（普通编辑、搜索覆盖层、补全菜单）的组合都需要测试。

**维护负担集中**。Editor 几乎每个版本都有交互改进或 bug 修复，它是 pi-tui 中变化最频繁的代码。

---

### 版本演化说明
> 本章核心分析基于 pi-mono v0.66.0。Editor 组件是 pi-tui 中变化最频繁的组件 —
> 几乎每个版本都有交互改进或 bug 修复。Paste marker 机制是后来添加的，
> 早期版本会直接将大粘贴内容全部显示在编辑器中。
