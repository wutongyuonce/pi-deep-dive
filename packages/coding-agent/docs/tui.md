> pi 可以创建 TUI 组件。请让它为你的用例构建一个。

# TUI 组件

扩展和自定义工具可以渲染自定义 TUI 组件以提供交互式用户界面。本文档介绍组件系统及可用的构建块。

**源码：** [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)

## 组件接口

所有组件都实现：

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
```

| 方法 | 描述 |
|--------|-------------|
| `render(width)` | 返回字符串数组（每行一个字符串）。每行**不得超过 `width`**。 |
| `handleInput?(data)` | 当组件获得焦点时接收键盘输入。 |
| `wantsKeyRelease?` | 如果为 true，组件将接收按键释放事件（Kitty 协议）。默认值：false。 |
| `invalidate()` | 清除缓存的渲染状态。在主题变更时调用。 |

TUI 会在每个渲染行的末尾追加一个完整的 SGR 重置和 OSC 8 重置。样式不会跨行延续。如果你输出带样式的多行文本，需要逐行重新应用样式，或者使用 `wrapTextWithAnsi()` 来确保每行包裹后的样式得以保留。

## 可聚焦接口（IME 支持）

需要显示文本光标并支持 IME（输入法编辑器）的组件应实现 `Focusable` 接口：

```typescript
import { CURSOR_MARKER, type Component, type Focusable } from "@earendil-works/pi-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;  // 由 TUI 在焦点变化时设置
  
  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    // 在虚拟光标前输出标记
    return [`> ${beforeCursor}${marker}\x1b[7m${atCursor}\x1b[27m${afterCursor}`];
  }
}
```

当 `Focusable` 组件获得焦点时，TUI 会：
1. 在组件上设置 `focused = true`
2. 扫描渲染输出中的 `CURSOR_MARKER`（一个零宽度的 APC 转义序列）
3. 将硬件终端光标定位到该位置
4. 显示硬件光标

这使得 IME 候选窗口能够在中日韩输入法的正确位置显示。内置的 `Editor` 和 `Input` 组件已经实现了此接口。

### 包含内嵌输入的容器组件

当容器组件（对话框、选择器等）包含 `Input` 或 `Editor` 子组件时，该容器必须实现 `Focusable` 并将焦点状态传播给子组件。否则，硬件光标将无法正确定位以供 IME 输入。

```typescript
import { Container, type Focusable, Input } from "@earendil-works/pi-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput: Input;

  // Focusable 实现 - 传播给子输入组件以支持 IME 光标定位
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor() {
    super();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
  }
}
```

如果没有这种传播，使用 IME（中文、日文、韩文等）输入时，候选窗口将显示在屏幕上的错误位置。

## 使用组件

**在扩展中**通过 `ctx.ui.custom()`：

```typescript
pi.on("session_start", async (_event, ctx) => {
  const handle = ctx.ui.custom(myComponent);
  // handle.requestRender() - 触发重新渲染
  // handle.close() - 恢复正常 UI
});
```

**在自定义工具中**通过 `pi.ui.custom()`：

```typescript
async execute(toolCallId, params, onUpdate, ctx, signal) {
  const handle = pi.ui.custom(myComponent);
  // ...
  handle.close();
}
```

## 覆盖层

覆盖层在不清除屏幕的情况下，在现有内容之上渲染组件。向 `ctx.ui.custom()` 传入 `{ overlay: true }`：

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyDialog({ onClose: done }),
  { overlay: true }
);
```

关于定位和大小的设置，使用 `overlayOptions`：

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new SidePanel({ onClose: done }),
  {
    overlay: true,
    overlayOptions: {
      // 大小：数字或百分比字符串
      width: "50%",          // 终端宽度的 50%
      minWidth: 40,          // 最小 40 列
      maxHeight: "80%",      // 最大终端高度的 80%

      // 位置：基于锚点（默认值："center"）
      anchor: "right-center", // 9 个位置：center、top-left、top-center 等
      offsetX: -2,            // 距锚点的偏移量
      offsetY: 0,

      // 或者使用百分比/绝对定位
      row: "25%",            // 距顶部 25%
      col: 10,               // 第 10 列

      // 边距
      margin: 2,             // 所有边，或 { top, right, bottom, left }

      // 响应式：在窄终端上隐藏
      visible: (termWidth, termHeight) => termWidth >= 80,
    },
    // 获取句柄以编程方式控制可见性
    onHandle: (handle) => {
      // handle.setHidden(true/false) - 切换可见性
      // handle.hide() - 永久移除
    },
  }
);
```

### 覆盖层生命周期

覆盖层组件在关闭时会被释放。不要复用引用——请每次都创建新的实例：

```typescript
// 错误 - 过期的引用
let menu: MenuComponent;
await ctx.ui.custom((_, __, ___, done) => {
  menu = new MenuComponent(done);
  return menu;
}, { overlay: true });
setActiveComponent(menu);  // 已释放

// 正确 - 重新调用以重新显示
const showMenu = () => ctx.ui.custom((_, __, ___, done) => 
  new MenuComponent(done), { overlay: true });

await showMenu();  // 第一次显示
await showMenu();  // "返回" = 再次调用即可
```

参见 [overlay-qa-tests.ts](../examples/extensions/overlay-qa-tests.ts) 获取涵盖锚点、边距、堆叠、响应式可见性和动画的完整示例。

## 内置组件

从 `@earendil-works/pi-tui` 导入：

```typescript
import { Text, Box, Container, Spacer, Markdown } from "@earendil-works/pi-tui";
```

### Text

支持自动换行的多行文本。

```typescript
const text = new Text(
  "Hello World",    // 内容
  1,                // 水平内边距（默认值：1）
  1,                // 垂直内边距（默认值：1）
  (s) => bgGray(s)  // 可选的背景函数
);
text.setText("已更新");
```

### Box

带内边距和背景颜色的容器。

```typescript
const box = new Box(
  1,                // 水平内边距
  1,                // 垂直内边距
  (s) => bgGray(s)  // 背景函数
);
box.addChild(new Text("内容", 0, 0));
box.setBgFn((s) => bgBlue(s));
```

### Container

将子组件垂直分组。

```typescript
const container = new Container();
container.addChild(component1);
container.addChild(component2);
container.removeChild(component1);
```

### Spacer

空的垂直空间。

```typescript
const spacer = new Spacer(2);  // 2 个空行
```

### Markdown

渲染带语法高亮的 markdown。

```typescript
const md = new Markdown(
  "# 标题\n\n这是**粗体**文本",
  1,        // 水平内边距
  1,        // 垂直内边距
  theme     // MarkdownTheme（见下文）
);
md.setText("已更新的 markdown");
```

### Image

在支持的终端（Kitty、iTerm2、Ghostty、WezTerm）中渲染图像。

```typescript
const image = new Image(
  base64Data,   // base64 编码的图像
  "image/png",  // MIME 类型
  theme,        // ImageTheme
  { maxWidthCells: 80, maxHeightCells: 24 }
);
```

## 键盘输入

使用 `matchesKey()` 进行按键检测：

```typescript
import { matchesKey, Key } from "@earendil-works/pi-tui";

handleInput(data: string) {
  if (matchesKey(data, Key.up)) {
    this.selectedIndex--;
  } else if (matchesKey(data, Key.enter)) {
    this.onSelect?.(this.selectedIndex);
  } else if (matchesKey(data, Key.escape)) {
    this.onCancel?.();
  } else if (matchesKey(data, Key.ctrl("c"))) {
    // Ctrl+C
  }
}
```

**按键标识符**（使用 `Key.*` 进行自动补全，或直接使用字符串字面量）：
- 基本按键：`Key.enter`、`Key.escape`、`Key.tab`、`Key.space`、`Key.backspace`、`Key.delete`、`Key.home`、`Key.end`
- 方向键：`Key.up`、`Key.down`、`Key.left`、`Key.right`
- 带修饰键：`Key.ctrl("c")`、`Key.shift("tab")`、`Key.alt("left")`、`Key.ctrlShift("p")`
- 字符串格式同样有效：`"enter"`、`"ctrl+c"`、`"shift+tab"`、`"ctrl+shift+p"`

## 行宽

**关键：** `render()` 返回的每一行都不得超过 `width` 参数。

```typescript
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

render(width: number): string[] {
  // 截断过长的行
  return [truncateToWidth(this.text, width)];
}
```

工具函数：
- `visibleWidth(str)` - 获取显示宽度（忽略 ANSI 码）
- `truncateToWidth(str, width, ellipsis?)` - 截断并可选添加省略号
- `wrapTextWithAnsi(str, width)` - 自动换行并保留 ANSI 码

## 创建自定义组件

示例：交互式选择器

```typescript
import {
  matchesKey, Key,
  truncateToWidth, visibleWidth
} from "@earendil-works/pi-tui";

class MySelector {
  private items: string[];
  private selected = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  
  public onSelect?: (item: string) => void;
  public onCancel?: () => void;

  constructor(items: string[]) {
    this.items = items;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected--;
      this.invalidate();
    } else if (matchesKey(data, Key.down) && this.selected < this.items.length - 1) {
      this.selected++;
      this.invalidate();
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.items[this.selected]);
    } else if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    this.cachedLines = this.items.map((item, i) => {
      const prefix = i === this.selected ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

在扩展中的使用：

```typescript
pi.registerCommand("pick", {
  description: "选择一个选项",
  handler: async (args, ctx) => {
    const items = ["选项 A", "选项 B", "选项 C"];
    const selector = new MySelector(items);
    
    let handle: { close: () => void; requestRender: () => void };
    
    await new Promise<void>((resolve) => {
      selector.onSelect = (item) => {
        ctx.ui.notify(`已选择: ${item}`, "info");
        handle.close();
        resolve();
      };
      selector.onCancel = () => {
        handle.close();
        resolve();
      };
      handle = ctx.ui.custom(selector);
    });
  }
});
```

## 主题

组件接受主题对象以进行样式设置。

**在 `renderCall`/`renderResult` 中**，使用 `theme` 参数：

```typescript
renderResult(result, options, theme, context) {
  // 使用 theme.fg() 设置前景色
  return new Text(theme.fg("success", "完成!"), 0, 0);
  
  // 使用 theme.bg() 设置背景色
  const styled = theme.bg("toolPendingBg", theme.fg("accent", "文本"));
}
```

**前景色**（`theme.fg(color, text)`）：

| 分类 | 颜色 |
|----------|--------|
| 通用 | `text`、`accent`、`muted`、`dim` |
| 状态 | `success`、`error`、`warning` |
| 边框 | `border`、`borderAccent`、`borderMuted` |
| 消息 | `userMessageText`、`customMessageText`、`customMessageLabel` |
| 工具 | `toolTitle`、`toolOutput` |
| 差异 | `toolDiffAdded`、`toolDiffRemoved`、`toolDiffContext` |
| Markdown | `mdHeading`、`mdLink`、`mdLinkUrl`、`mdCode`、`mdCodeBlock`、`mdCodeBlockBorder`、`mdQuote`、`mdQuoteBorder`、`mdHr`、`mdListBullet` |
| 语法 | `syntaxComment`、`syntaxKeyword`、`syntaxFunction`、`syntaxVariable`、`syntaxString`、`syntaxNumber`、`syntaxType`、`syntaxOperator`、`syntaxPunctuation` |
| 思考 | `thinkingOff`、`thinkingMinimal`、`thinkingLow`、`thinkingMedium`、`thinkingHigh`、`thinkingXhigh` |
| 模式 | `bashMode` |

**背景色**（`theme.bg(color, text)`）：

`selectedBg`、`userMessageBg`、`customMessageBg`、`toolPendingBg`、`toolSuccessBg`、`toolErrorBg`

**对于 Markdown**，使用 `getMarkdownTheme()`：

```typescript
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

renderResult(result, options, theme, context) {
  const mdTheme = getMarkdownTheme();
  return new Markdown(result.details.markdown, 0, 0, mdTheme);
}
```

**对于自定义组件**，定义自己的主题接口：

```typescript
interface MyTheme {
  selected: (s: string) => string;
  normal: (s: string) => string;
}
```

## 调试日志

设置 `PI_TUI_WRITE_LOG` 来捕获写入 stdout 的原始 ANSI 流。

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log npx tsx packages/tui/test/chat-simple.ts
```

## 性能

尽可能缓存渲染输出：

```typescript
class CachedComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    // ... 计算行内容 ...
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

状态变化时调用 `invalidate()`，然后调用 `handle.requestRender()` 触发重新渲染。

## 失效与主题变更

当主题变更时，TUI 会在所有组件上调用 `invalidate()` 以清除其缓存。组件必须正确实现 `invalidate()` 以确保主题变更生效。

### 问题

如果组件将主题颜色预烘焙到字符串中（通过 `theme.fg()`、`theme.bg()` 等）并缓存了它们，则缓存的字符串包含旧主题的 ANSI 转义码。仅清除渲染缓存是不够的，如果组件另外存储了主题化内容的话。

**错误方法**（主题颜色不会更新）：

```typescript
class BadComponent extends Container {
  private content: Text;

  constructor(message: string, theme: Theme) {
    super();
    // 预烘焙的主题颜色存储在 Text 组件中
    this.content = new Text(theme.fg("accent", message), 1, 0);
    this.addChild(this.content);
  }
  // 没有重写 invalidate - 父类的 invalidate 仅清除
  // 子组件的渲染缓存，不会清除预烘焙的内容
}
```

### 解决方案

使用主题颜色构建内容的组件必须在调用 `invalidate()` 时重建该内容：

```typescript
class GoodComponent extends Container {
  private message: string;
  private content: Text;

  constructor(message: string) {
    super();
    this.message = message;
    this.content = new Text("", 1, 0);
    this.addChild(this.content);
    this.updateDisplay();
  }

  private updateDisplay(): void {
    // 使用当前主题重建内容
    this.content.setText(theme.fg("accent", this.message));
  }

  override invalidate(): void {
    super.invalidate();  // 清除子缓存
    this.updateDisplay(); // 使用新主题重建
  }
}
```

### 模式：失效时重建

对于包含复杂内容的组件：

```typescript
class ComplexComponent extends Container {
  private data: SomeData;

  constructor(data: SomeData) {
    super();
    this.data = data;
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();  // 移除所有子组件

    // 使用当前主题构建 UI
    this.addChild(new Text(theme.fg("accent", theme.bold("标题")), 1, 0));
    this.addChild(new Spacer(1));

    for (const item of this.data.items) {
      const color = item.active ? "success" : "muted";
      this.addChild(new Text(theme.fg(color, item.label), 1, 0));
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.rebuild();
  }
}
```

### 何时需要此模式

此模式在以下情况时需要：

1. **预烘焙主题颜色** - 使用 `theme.fg()` 或 `theme.bg()` 创建存储在子组件中的样式化字符串
2. **语法高亮** - 使用 `highlightCode()`，它会应用基于主题的语法颜色
3. **复杂布局** - 构建内嵌主题颜色的子组件树

此模式在以下情况时不需要：

1. **使用主题回调** - 传递函数如 `(text) => theme.fg("accent", text)`，在渲染时调用
2. **简单容器** - 仅组合其他组件，不添加主题化内容
3. **无状态渲染** - 在每次 `render()` 调用时重新计算主题化输出（无缓存）

## 常见模式

以下模式涵盖了扩展中最常见的 UI 需求。**直接复制这些模式，无需从头构建。**

### 模式 1：选择对话框（SelectList）

用于让用户从选项列表中选择。使用 `@earendil-works/pi-tui` 的 `SelectList`，配合 `DynamicBorder` 进行边框装饰。

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

pi.registerCommand("pick", {
  handler: async (_args, ctx) => {
    const items: SelectItem[] = [
      { value: "opt1", label: "选项 1", description: "第一个选项" },
      { value: "opt2", label: "选项 2", description: "第二个选项" },
      { value: "opt3", label: "选项 3" },  // description 是可选的
    ];

    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();

      // 顶部边框
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      // 标题
      container.addChild(new Text(theme.fg("accent", theme.bold("选择一个选项")), 1, 0));

      // 带主题的 SelectList
      const selectList = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);

      // 帮助文本
      container.addChild(new Text(theme.fg("dim", "↑↓ 导航 • enter 选择 • esc 取消"), 1, 0));

      // 底部边框
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
      };
    });

    if (result) {
      ctx.ui.notify(`已选择: ${result}`, "info");
    }
  },
});
```

**示例：** [preset.ts](../examples/extensions/preset.ts)、[tools.ts](../examples/extensions/tools.ts)

### 模式 2：带取消的异步操作（BorderedLoader）

用于需要时间且应可取消的操作。`BorderedLoader` 显示旋转指示器并处理 escape 键来取消。

```typescript
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

pi.registerCommand("fetch", {
  handler: async (_args, ctx) => {
    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, "正在获取数据...");
      loader.onAbort = () => done(null);

      // 执行异步工作
      fetchData(loader.signal)
        .then((data) => done(data))
        .catch(() => done(null));

      return loader;
    });

    if (result === null) {
      ctx.ui.notify("已取消", "info");
    } else {
      ctx.ui.setEditorText(result);
    }
  },
});
```

**示例：** [qna.ts](../examples/extensions/qna.ts)、[handoff.ts](../examples/extensions/handoff.ts)

### 模式 3：设置/开关（SettingsList）

用于切换多个设置。使用 `@earendil-works/pi-tui` 的 `SettingsList`，配合 `getSettingsListTheme()`。

```typescript
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

pi.registerCommand("settings", {
  handler: async (_args, ctx) => {
    const items: SettingItem[] = [
      { id: "verbose", label: "详细模式", currentValue: "off", values: ["on", "off"] },
      { id: "color", label: "彩色输出", currentValue: "on", values: ["on", "off"] },
    ];

    await ctx.ui.custom((_tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("设置")), 1, 1));

      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        getSettingsListTheme(),
        (id, newValue) => {
          // 处理值变更
          ctx.ui.notify(`${id} = ${newValue}`, "info");
        },
        () => done(undefined),  // 关闭时
        { enableSearch: true }, // 可选：启用按标签的模糊搜索
      );
      container.addChild(settingsList);

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => settingsList.handleInput?.(data),
      };
    });
  },
});
```

**示例：** [tools.ts](../examples/extensions/tools.ts)

### 模式 4：持久化状态指示器

在页脚显示跨渲染持久化的状态。适用于模式指示器。

```typescript
// 设置状态（显示在页脚）
ctx.ui.setStatus("my-ext", ctx.ui.theme.fg("accent", "● 活跃"));

// 清除状态
ctx.ui.setStatus("my-ext", undefined);
```

**示例：** [status-line.ts](../examples/extensions/status-line.ts)、[plan-mode.ts](../examples/extensions/plan-mode.ts)、[preset.ts](../examples/extensions/preset.ts)

### 模式 4b：工作指示器自定义

自定义 pi 流式输出回复时显示的内联工作指示器。

```typescript
// 静态指示器
ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });

// 自定义动画指示器
ctx.ui.setWorkingIndicator({
  frames: [
    ctx.ui.theme.fg("dim", "·"),
    ctx.ui.theme.fg("muted", "•"),
    ctx.ui.theme.fg("accent", "●"),
    ctx.ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});

// 完全隐藏指示器
ctx.ui.setWorkingIndicator({ frames: [] });

// 恢复 pi 的默认旋转器
ctx.ui.setWorkingIndicator();
```

这仅影响正常的流式工作指示器。压缩和重试加载器保持其内置样式。自定义帧会按原样渲染，因此扩展在需要时必须自行添加颜色。

**示例：** [working-indicator.ts](../examples/extensions/working-indicator.ts)

### 模式 5：编辑器上方/下方的组件

在输入编辑器上方或下方显示持久化内容。适用于待办列表、进度等。

```typescript
// 简单字符串数组（默认在编辑器上方）
ctx.ui.setWidget("my-widget", ["第 1 行", "第 2 行"]);

// 在编辑器下方渲染
ctx.ui.setWidget("my-widget", ["第 1 行", "第 2 行"], { placement: "belowEditor" });

// 或者带主题
ctx.ui.setWidget("my-widget", (_tui, theme) => {
  const lines = items.map((item, i) =>
    item.done
      ? theme.fg("success", "✓ ") + theme.fg("muted", item.text)
      : theme.fg("dim", "○ ") + item.text
  );
  return {
    render: () => lines,
    invalidate: () => {},
  };
});

// 清除
ctx.ui.setWidget("my-widget", undefined);
```

**示例：** [plan-mode.ts](../examples/extensions/plan-mode.ts)

### 模式 6：自定义页脚

替换页脚。`footerData` 暴露扩展通常无法访问的数据。

```typescript
ctx.ui.setFooter((tui, theme, footerData) => ({
  invalidate() {},
  render(width: number): string[] {
    // footerData.getGitBranch(): string | null
    // footerData.getExtensionStatuses(): ReadonlyMap<string, string>
    return [`${ctx.model?.id} (${footerData.getGitBranch() || "无 git"})`];
  },
  dispose: footerData.onBranchChange(() => tui.requestRender()), // 响应式
}));

ctx.ui.setFooter(undefined); // 恢复默认
```

Token 统计可通过 `ctx.sessionManager.getBranch()` 和 `ctx.model` 获取。

**示例：** [custom-footer.ts](../examples/extensions/custom-footer.ts)

### 模式 7：自定义编辑器（vim 模式等）

将主输入编辑器替换为自定义实现。适用于模态编辑（vim）、不同的键绑定（emacs）或专门的输入处理。

```typescript
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

type Mode = "normal" | "insert";

class VimEditor extends CustomEditor {
  private mode: Mode = "insert";

  handleInput(data: string): void {
    // Escape：切换到普通模式，或传递给应用处理
    if (matchesKey(data, "escape")) {
      if (this.mode === "insert") {
        this.mode = "normal";
        return;
      }
      // 在普通模式下，escape 中止 agent（由 CustomEditor 处理）
      super.handleInput(data);
      return;
    }

    // 插入模式：将所有内容传递给 CustomEditor
    if (this.mode === "insert") {
      super.handleInput(data);
      return;
    }

    // 普通模式：vim 风格导航
    switch (data) {
      case "i": this.mode = "insert"; return;
      case "h": super.handleInput("\x1b[D"); return; // 左
      case "j": super.handleInput("\x1b[B"); return; // 下
      case "k": super.handleInput("\x1b[A"); return; // 上
      case "l": super.handleInput("\x1b[C"); return; // 右
    }
    // 将未处理的按键传递给 super（ctrl+c 等），但过滤可打印字符
    if (data.length === 1 && data.charCodeAt(0) >= 32) return;
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    // 在底部边框添加模式指示器（使用 truncateToWidth 进行 ANSI 安全的截断）
    if (lines.length > 0) {
      const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
      const lastLine = lines[lines.length - 1]!;
      // 传入 "" 作为省略号，避免截断时添加 "..."
      lines[lines.length - 1] = truncateToWidth(lastLine, width - label.length, "") + label;
    }
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // 工厂函数接收应用的主题和键绑定
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new VimEditor(theme, keybindings)
    );
  });
}
```

**关键要点：**

- **继承 `CustomEditor`**（而不是基础 `Editor`），以获取应用的键绑定（escape 中止、ctrl+d 退出、模型切换等）
- **调用 `super.handleInput(data)`** 处理你不处理的按键
- **工厂模式**：`setEditorComponent` 接收一个工厂函数，该函数获取 `tui`、`theme` 和 `keybindings`
- **传入 `undefined`** 恢复默认编辑器：`ctx.ui.setEditorComponent(undefined)`

**示例：** [modal-editor.ts](../examples/extensions/modal-editor.ts)

## 关键规则

1. **始终从回调中获取 theme** - 不要直接导入 theme。使用 `ctx.ui.custom((tui, theme, keybindings, done) => ...)` 回调中的 `theme`。

2. **始终为 DynamicBorder 的颜色参数添加类型** - 写 `(s: string) => theme.fg("accent", s)`，而不是 `(s) => theme.fg("accent", s)`。

3. **状态变化后调用 tui.requestRender()** - 在 `handleInput` 中，更新状态后调用 `tui.requestRender()`。

4. **返回三个方法的对象** - 自定义组件需要 `{ render, invalidate, handleInput }`。

5. **使用现有组件** - `SelectList`、`SettingsList`、`BorderedLoader` 覆盖了 90% 的用例。不要重复造轮子。

## 示例

- **选择 UI**：[examples/extensions/preset.ts](../examples/extensions/preset.ts) - 带 DynamicBorder 边框的 SelectList
- **带取消的异步操作**：[examples/extensions/qna.ts](../examples/extensions/qna.ts) - 用于 LLM 调用的 BorderedLoader
- **设置开关**：[examples/extensions/tools.ts](../examples/extensions/tools.ts) - 用于工具启用/禁用的 SettingsList
- **状态指示器**：[examples/extensions/plan-mode.ts](../examples/extensions/plan-mode.ts) - setStatus 和 setWidget
- **工作指示器**：[examples/extensions/working-indicator.ts](../examples/extensions/working-indicator.ts) - setWorkingIndicator
- **自定义页脚**：[examples/extensions/custom-footer.ts](../examples/extensions/custom-footer.ts) - 带统计信息的 setFooter
- **自定义编辑器**：[examples/extensions/modal-editor.ts](../examples/extensions/modal-editor.ts) - 类 Vim 的模态编辑
- **贪吃蛇游戏**：[examples/extensions/snake.ts](../examples/extensions/snake.ts) - 带键盘输入、游戏循环的完整游戏
- **自定义工具渲染**：[examples/extensions/todo.ts](../examples/extensions/todo.ts) - renderCall 和 renderResult
