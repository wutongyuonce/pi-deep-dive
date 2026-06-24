# 第 24 章：`pi-tui` — 在终端里做应用

> **定位**：本章解析 pi 为什么自建 TUI 框架，以及极简 Component 接口如何撑起复杂交互。
> 前置依赖：第 10 章（Agent 事件订阅）。
> 适用场景：当你想理解终端 UI 的渲染模型，或者想为 pi 的 TUI 添加组件。

## 为什么不用 Ink.js？

Node.js 生态有成熟的终端 UI 框架（Ink.js 基于 React 的声明式模型）。pi 选择自建，原因是 **差分渲染的完全控制权**。

Ink.js 使用 React 的 reconciliation 算法来管理组件树，然后把组件树渲染成终端输出。问题在于：终端不是浏览器 DOM — 你不能"修改一个元素"，你只能覆盖某一行的内容。Ink.js 的抽象层让你无法精确控制"哪些行需要重绘"，导致不必要的全屏刷新。

pi-tui 选择了一个更底层的模型：组件返回字符串数组，TUI 逐行比较新旧输出，只重绘变化的行。

## Component 接口：一个方法定义一切

```typescript
// packages/tui/src/tui.ts:17-41
export interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
```

`render` 返回字符串数组（每个元素是一行）。就是这么简单 — 没有 virtual DOM，没有 JSX，没有 state management。一个组件的全部职责就是：给你一个宽度，你告诉我你要显示什么。

`handleInput` 是可选的 — 只有能接收键盘输入的组件（比如 Editor、SelectList）才需要实现它。参数 `data` 是原始的终端输入序列（可能是单个字符如 `"a"`，也可能是转义序列如 `"\x1b[A"` 表示方向上键）。

`wantsKeyRelease` 控制组件是否接收按键释放事件。这需要 Kitty keyboard protocol 支持（普通终端不区分 keydown 和 keyup）。默认 `false` — 释放事件被 TUI 过滤掉，减少组件需要处理的事件量。

`invalidate()` 通知 TUI 组件需要重绘。调用后 TUI 会在下一个 render cycle 重新调用 `render()`。组件的缓存状态（如果有的话）也应该在 `invalidate()` 中清除。

## Focusable 接口与硬件光标

```typescript
// packages/tui/src/tui.ts:52-68
export interface Focusable {
  focused: boolean;
}

export const CURSOR_MARKER = "\x1b_pi:c\x07";
```

`Focusable` 是 `Component` 的增强接口。当一个组件获得焦点时，TUI 设置它的 `focused` 属性为 `true`。组件在 `render()` 中如果需要显示光标（比如编辑器的文本光标），就在光标位置输出 `CURSOR_MARKER`。

`CURSOR_MARKER` 是一个 APC（Application Program Command）转义序列 — 终端会忽略它，但 TUI 可以在渲染后找到它的位置，然后把硬件光标移到那里。

为什么需要硬件光标？因为 **IME 输入法**。中文、日文、韩文的输入法需要知道光标位置来显示候选窗口。如果没有正确定位的硬件光标，候选窗口会出现在错误的位置。这个看似小众的需求，决定了 pi-tui 必须实现光标追踪。

## TUI 类：渲染引擎

```typescript
// packages/tui/src/tui.ts:214-245
export class TUI extends Container {
  public terminal: Terminal;
  private previousLines: string[] = [];
  private previousWidth = 0;
  private previousHeight = 0;
  private focusedComponent: Component | null = null;
  private renderRequested = false;
  private renderTimer: NodeJS.Timeout | undefined;
  private lastRenderAt = 0;
  private static readonly MIN_RENDER_INTERVAL_MS = 16;
  private cursorRow = 0;
  private hardwareCursorRow = 0;
  private maxLinesRendered = 0;
  // Overlay stack for modal components
  private overlayStack: {
    component: Component;
    options?: OverlayOptions;
    preFocus: Component | null;
    hidden: boolean;
    focusOrder: number;
  }[] = [];
}
```

TUI 自身继承了 `Container`（组件树的容器），同时管理渲染状态。几个关键的状态字段：

- `previousLines`：上一次渲染的输出，用于差分比较
- `MIN_RENDER_INTERVAL_MS = 16`：渲染节流，约 60fps 上限，防止高频 invalidate 导致 CPU 空转
- `maxLinesRendered`：终端工作区域的最大高度，用于检测内容收缩时是否需要清理空行

## 渲染调度：requestRender

```typescript
// packages/tui/src/tui.ts:469-516
requestRender(force = false): void {
  if (force) {
    this.previousLines = [];
    this.previousWidth = -1;
    this.previousHeight = -1;
    // ...重置所有状态...
    process.nextTick(() => {
      this.doRender();
    });
    return;
  }
  if (this.renderRequested) return;
  this.renderRequested = true;
  process.nextTick(() => this.scheduleRender());
}

private scheduleRender(): void {
  const elapsed = performance.now() - this.lastRenderAt;
  const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed);
  this.renderTimer = setTimeout(() => {
    this.doRender();
  }, delay);
}
```

`requestRender` 有两种模式：

- **`force = true`**：清空所有缓存，下一个 tick 立即全量渲染。用于主题切换、终端 reset 等场景。
- **`force = false`**（默认）：标记"需要渲染"，通过 `scheduleRender` 节流到至少 16ms 间隔。多次快速的 `requestRender` 调用只会触发一次实际渲染。

`process.nextTick` 确保渲染在当前事件循环结束后执行 — 这让同一个 tick 中的多个状态变更可以合并为一次渲染。

## 差分渲染算法

`doRender()` 是 TUI 的核心。它的逻辑可以分为四个阶段：

```mermaid
flowchart TD
    Render["1. component.render(width)"] --> Composite["2. compositeOverlays()"]
    Composite --> Compare{"3. 和 previousLines\n逐行比较"}
    Compare -->|"首次渲染"| Full["输出全部行"]
    Compare -->|"宽度变化"| Clear["清屏 + 全部重绘"]
    Compare -->|"内容变化"| Diff["跳到 firstChanged\n输出到 lastChanged"]
    Compare -->|"无变化"| Skip["跳过渲染\n只更新光标"]
    
    Full --> Sync["synchronized output\nCSI ?2026h ... ?2026l"]
    Clear --> Sync
    Diff --> Sync
    
    style Diff fill:#c8e6c9
```

差分阶段的核心代码：

```typescript
// packages/tui/src/tui.ts:981-1011
// Find first and last changed lines
let firstChanged = -1;
let lastChanged = -1;
const maxLines = Math.max(
  newLines.length, this.previousLines.length
);
for (let i = 0; i < maxLines; i++) {
  const oldLine = this.previousLines[i] ?? "";
  const newLine = newLines[i] ?? "";
  if (oldLine !== newLine) {
    if (firstChanged === -1) firstChanged = i;
    lastChanged = i;
  }
}
```

算法的关键洞察：只需要找到**第一个**和**最后一个**变化行。然后把光标移到第一个变化行，从那里开始输出到最后一个变化行。不需要逐行比较和逐行更新 — 因为终端的 cursor movement 本身也有开销，连续输出比跳跃输出更快。

特殊情况处理：

- **宽度变化**：必须全量重绘，因为换行位置全部改变
- **高度变化**：全量重绘（Termux 例外 — 软键盘弹出会频繁改变高度）
- **内容收缩**：可选地清理空行（`clearOnShrink`），避免在长输出消失后留下视觉残留

## Synchronized Output

每次渲染都包裹在 synchronized output 序列中：

```typescript
// packages/tui/src/tui.ts:917-923
let buffer = "\x1b[?2026h"; // Begin synchronized output
// ...写入所有行...
buffer += "\x1b[?2026l"; // End synchronized output
this.terminal.write(buffer);
```

CSI `?2026h` 告诉终端"开始缓冲"，`?2026l` 告诉终端"一次性显示"。没有这个序列，逐行输出会导致可见的闪烁 — 用户能看到旧内容被逐行替换为新内容的过程。synchronized output 让更新在视觉上是原子的。

注意：不是所有终端都支持 CSI 2026。不支持的终端会忽略这些序列，退化为逐行更新。这种优雅降级是 pi-tui 的设计哲学之一 — 利用先进终端的能力，但不依赖它们。

## Overlay 系统

```typescript
// packages/tui/src/tui.ts:119-155
export interface OverlayOptions {
  width?: SizeValue;
  minWidth?: number;
  maxHeight?: SizeValue;
  anchor?: OverlayAnchor;
  offsetX?: number;
  offsetY?: number;
  row?: SizeValue;
  col?: SizeValue;
  margin?: OverlayMargin | number;
  visible?: (termWidth: number, termHeight: number) => boolean;
  nonCapturing?: boolean;
}
```

Overlay 是渲染在主内容之上的浮动组件。典型用途：自动补全菜单、模型选择器、键绑定帮助。

Overlay 的定位支持三种模式：

1. **锚点模式**（`anchor`）：9 个预定义位置（center、top-left、bottom-right 等）
2. **百分比模式**（`row: "25%"`）：相对终端大小定位
3. **绝对模式**（`row: 5, col: 10`）：固定位置

`visible` 回调让 overlay 可以根据终端尺寸动态显示/隐藏 — 比如在终端宽度小于 60 列时隐藏侧边栏 overlay。

Overlay 有独立的焦点管理。`showOverlay` 返回一个 `OverlayHandle`，可以控制显示/隐藏、焦点获取/释放。焦点释放时自动恢复到之前的焦点组件（`preFocus`）。

Overlay 的渲染发生在 `compositeOverlays` 阶段 — 先渲染主内容，再把 overlay 的输出合成到对应位置。差分比较在合成之后进行，所以 overlay 的变化也受益于差分渲染。

## Container：组件树的基础

```typescript
// packages/tui/src/tui.ts:178-209
export class Container implements Component {
  children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const child of this.children) {
      lines.push(...child.render(width));
    }
    return lines;
  }
}
```

Container 是组件树的容器节点。它的 `render` 简单地拼接所有子组件的输出。TUI 自身继承 Container — 整个 UI 就是一棵组件树，TUI 是根节点。

这个设计的简洁性值得注意：没有 layout engine，没有 flex/grid，没有 padding/margin。所有布局都由组件自己在 `render()` 中通过字符串拼接实现。这看起来原始，但对终端 UI 来说足够了 — 终端的布局模型本质上就是"一行一行堆叠"。

## 取舍分析

### 得到了什么

**完全的控制力**。差分渲染的粒度、IME 支持（通过 CURSOR_MARKER 定位硬件光标）、Kitty keyboard protocol 支持 — 这些都需要直接操作终端转义序列，框架反而会碍事。

**极低的渲染开销**。字符串比较 + 只重绘变化行的策略，让 TUI 在高频更新场景（比如 bash 命令的流式输出）下保持流畅。

**渲染节流防抖**。16ms 的最小渲染间隔和 `requestRender` 的去重机制，确保即使组件频繁触发 invalidate，CPU 消耗也是可控的。

### 放弃了什么

**更多的维护成本**。从字符宽度计算到 ANSI 转义序列解析，都要自己实现。`visibleWidth()`、`truncateToWidth()`、`wrapTextWithAnsi()` 这些工具函数证明了"终端里的文本处理"远比想象复杂。

**没有声明式 API**。相比 React/Ink.js 的声明式模型，命令式的 `render()` 方法需要组件自己管理所有状态和渲染逻辑。但 Component 接口的简洁性在某种程度上弥补了这一点 — 实现一个新组件只需要一个 `render(width): string[]` 方法。

---

### 版本演化说明
> 本章核心分析基于 pi-mono v0.66.0。pi-tui 是 pi-mono 中最稳定的包之一。
> Component 接口自创建以来没有改变，新功能通过添加新组件实现。
> Overlay 系统是后来添加的 — 早期版本的模态交互（如模型选择）直接替换主内容。
