# 第 21 章：`read` 的设计 — 为什么不是简单的 `cat`

> **定位**：本章解析 read 工具如何在"给 LLM 看文件"时做保护性设计。
> 前置依赖：第 19 章（工具设计原则）。
> 适用场景：当你想理解为什么 read 工具不直接 `cat` 文件给 LLM。

## 为什么不直接 `cat`？

`cat` 的问题是它没有任何保护。一个 100MB 的二进制文件会被原样输出到 LLM context 中，消耗全部 token 窗口而不产生任何有用信息。

pi 的 read 工具做了三层保护：

**1. 偏移与分页**。`offset` 和 `limit` 参数让 LLM 可以只读文件的一部分。LLM 不需要一次加载整个大文件。

**2. 截断策略**。超过一定大小的输出会被截断，附带提示信息告诉 LLM "还有更多内容，请用偏移参数继续读"。

**3. 续读提示**。如果输出被截断，read 会附带续读提示告知 LLM "还有更多内容，请用 offset 参数继续读"。这让 LLM 可以按需增量读取大文件，而不是一次性加载。

## Schema 定义：三个参数撑起整个读取逻辑

```typescript
// packages/coding-agent/src/core/tools/read.ts:17-21
const readSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to read (relative or absolute)"
  }),
  offset: Type.Optional(Type.Number({
    description: "Line number to start reading from (1-indexed)"
  })),
  limit: Type.Optional(Type.Number({
    description: "Maximum number of lines to read"
  })),
});
```

注意 `offset` 是 1-indexed。LLM 如果需要从第 42 行继续读，直接传 `offset: 42` 就可以。截断提示中会告知总行数和当前读到的位置，让 LLM 知道如何继续。

## 截断的双重限制

read 工具的截断不是简单的"只看前 N 行"。它有两个独立的限制条件，先触发的那个生效：

```typescript
// packages/coding-agent/src/core/tools/truncate.ts:11-13
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
```

为什么需要两个限制？因为行数和字节数衡量的是不同维度的资源消耗：

- **2000 行限制**防止 LLM context 被大量短行填满（比如一个巨大的 JSON 文件，每行都很短但总行数惊人）
- **50KB 字节限制**防止少量超长行消耗大量 token（比如 minified JavaScript，一行就可能有几百 KB）

`TruncationResult` 类型记录了完整的截断元信息：

```typescript
// packages/coding-agent/src/core/tools/truncate.ts:15-38
export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}
```

`firstLineExceedsLimit` 是一个有趣的边界情况处理：如果文件的第一行就超过了 50KB 限制（比如 minified CSS），read 不会返回一个被截断到一半的行，而是返回一条提示让 LLM 用 bash 的 `sed` + `head -c` 来读取。这比返回半截内容更有用 — 半截的 minified CSS 对 LLM 没有任何帮助。

## 图片读取：自动检测与 base64 编码

Read 工具不仅读文本 — 它能检测并正确返回图片文件。这对多模态 LLM 至关重要：

```typescript
// packages/coding-agent/src/core/tools/read.ts:32-40
export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (
    absolutePath: string
  ) => Promise<string | null | undefined>;
}
```

当 `detectImageMimeType` 返回非空值时，read 走图片路径而非文本路径。流程是：

1. 读取文件为 `Buffer`
2. 转换为 base64 编码字符串
3. 如果 `autoResizeImages` 开启（默认），调用 `resizeImage()` 将图片缩放到 2000x2000 以内
4. 返回一个包含 `TextContent`（描述信息）和 `ImageContent`（base64 数据）的数组

```typescript
// packages/coding-agent/src/core/tools/read.ts:157-183
const mimeType = ops.detectImageMimeType
  ? await ops.detectImageMimeType(absolutePath)
  : undefined;

if (mimeType) {
  const buffer = await ops.readFile(absolutePath);
  const base64 = buffer.toString("base64");
  if (autoResizeImages) {
    const resized = await resizeImage({
      type: "image", data: base64, mimeType
    });
    if (!resized) {
      content = [{
        type: "text",
        text: `Read image file [${mimeType}]\n` +
          `[Image omitted: could not be resized ...]`
      }];
    } else {
      content = [
        { type: "text", text: `Read image file [${resized.mimeType}]` },
        { type: "image", data: resized.data, mimeType: resized.mimeType }
      ];
    }
  }
}
```

`autoResizeImages` 的默认值是 `true`。这意味着用户截图一个 4K 显示器的屏幕（几 MB 的 PNG），read 会自动缩小到合理尺寸再发送给 LLM。这避免了图片 token 消耗失控 — API 按图片像素数计费，一张 4K 截图可能消耗几千 token。

resize 失败时不会报错，而是返回一条 "Image omitted" 的文本提示。这种优雅降级确保了 read 工具永远不会因为图片处理失败而让整个 tool call 失败。

## 非文本文件的处理边界

read 工具的 schema 只有 `path`、`offset`、`limit` 三个参数 — 没有 PDF 页码范围、Jupyter cell 选择等专用参数。它的设计重心是**文本文件和图片**。

对于 PDF 和 Jupyter notebook 等格式，read 工具不提供专用的参数化支持。如果 LLM 需要处理这些格式，通常会退回到 bash 工具使用专门的命令行工具（如 `pdftotext`）。这是"专用工具做专用事"原则的体现 — read 不试图成为万能的文件解析器。

## `ReadOperations` 的 Pluggable 设计

和其他工具一样，read 通过接口抽象了底层操作：

```typescript
// packages/coding-agent/src/core/tools/read.ts:42-46
const defaultReadOperations: ReadOperations = {
  readFile: (path) => fsReadFile(path),
  access: (path) => fsAccess(path, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};
```

默认实现直接调用 Node.js 的 `fs` 模块读取本地文件。但 `ReadOperations` 可以被替换为：

- **SSH 远程读取**：通过 SSH 连接读取远程服务器上的文件
- **Docker 容器读取**：读取容器内的文件系统
- **Git blob 读取**：直接从 git object store 读取文件内容

这种可插拔设计让 read 工具在不修改核心逻辑的情况下适应不同的执行环境。

## TUI 中的渲染：语法高亮与折叠

read 结果在 TUI 中的展示也经过了精心设计。`formatReadResult` 函数会：

1. 根据文件扩展名检测语言（`getLanguageFromPath`）
2. 对代码内容做语法高亮（`highlightCode`）
3. 默认只显示前 10 行，更多内容需要用户手动展开
4. 截断信息用 warning 色显示，提示 LLM 输出被限制了

```typescript
// packages/coding-agent/src/core/tools/read.ts:93-98
const maxLines = options.expanded ? lines.length : 10;
const displayLines = lines.slice(0, maxLines);
const remaining = lines.length - maxLines;
if (remaining > 0) {
  text += `... (${remaining} more lines, press key to expand)`;
}
```

这里有一个微妙的分层：LLM 看到的是完整的截断后内容（最多 2000 行/50KB），但用户在 TUI 中看到的默认只有 10 行。两个截断分别服务不同的受众 — LLM 需要足够的上下文做决策，用户只需要确认 read 读对了文件。

## 取舍分析

### 得到了什么

**安全的文件探索**。LLM 不会因为读了一个大文件而耗尽 context。`offset/limit` 配合续读提示让 read → read 的增量探索工作流更流畅。双重截断限制（行数 + 字节数）覆盖了不同类型文件的边界情况。

**文本与图片支持**。同一个 read 工具处理文本文件和图片，LLM 不需要为这两种常见格式学习不同的工具。图片通过自动检测 MIME 类型走 base64 路径。

**可插拔的执行后端**。`ReadOperations` 接口让 read 工具可以适应本地、远程、容器等不同环境。

### 放弃了什么

**截断丢失上下文**。截断意味着 LLM 可能需要多次 read 调用才能获取完整信息。但相比一次性加载大文件耗尽 context window 的后果，这个开销值得。

**图片 resize 可能丢失细节**。自动缩放到 2000x2000 以内意味着 LLM 看不到高分辨率的细节。对于需要像素级精度的场景（比如 UI 截图中的小字体），这是一个潜在的问题。但对大多数场景，缩放后的图片已经足够。

---

### 版本演化说明
> 本章核心分析基于 pi-mono v0.66.0。Read 工具支持文本文件读取（带截断保护）
> 和图片读取（自动检测图片格式并返回 base64 编码）。
> `ReadOperations` 的 pluggable 设计在图片支持添加时一同引入。
