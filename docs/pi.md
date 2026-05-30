# pi

> https://mariozechner.at/posts/2025-11-30-pi-coding-agent/

```
pi-tui (终端渲染库)          ← 零内部依赖，纯渲染层
pi-ai  (LLM 统一 API)       ← 零内部依赖，纯 AI 层

    ↓ pi-agent-core 依赖 pi-ai
pi-agent-core (agent 引擎)   ← 依赖 pi-ai

    ↓ pi-coding-agent 依赖 pi-ai + pi-agent-core + pi-tui
pi-coding-agent (终端应用)   ← 依赖全部三个
```

## pi-ai and pi-agent-core

**[pi-ai](https://github.com/badlogic/pi-mono/tree/main/packages/ai)** ：一个统一的 LLM API，支持多提供商（Anthropic、OpenAI、Google、xAI、Groq、Cerebras、OpenRouter 和任何 OpenAI 兼容的端点）、流式传输、使用 TypeBox 模式调用工具、思维/推理支持、无缝跨提供商上下文切换以及令牌和成本跟踪。

**[pi-agent-core](https://github.com/badlogic/pi-mono/tree/main/packages/agent)** ：一个处理工具执行、验证和事件流的代理循环。

实际上只需要使用四个 API： [OpenAI 的 Completions API](https://platform.openai.com/docs/api-reference/chat/create) 、他们较新的 [Responses API](https://platform.openai.com/docs/api-reference/responses) 、 [Anthropic 的 Messages API](https://docs.anthropic.com/en/api/messages) 

### Context handoff 上下文交接

pi-ai 从设计之初就考虑到了不同提供商之间的上下文切换。由于每个提供商都有自己追踪工具调用和思维轨迹的方式，因此只能尽力而为。例如，如果在会话中途从 Anthropic 切换到 OpenAI，Anthropic 的思维轨迹会被转换成助手消息中的内容块，并以 `<thinking></thinking>` 标签分隔。这种做法是否合理尚待商榷，因为 Anthropic 和 OpenAI 返回的思维轨迹实际上并不能反映幕后发生的情况。

这些提供程序还会将已签名的数据块插入到事件流中，后续包含相同消息的请求必须重放这些数据块。在同一提供程序内切换模型时，也会出现这种情况。这导致后台存在繁琐的抽象和转换管道。

```typescript
import { getModel, complete, Context } from '@mariozechner/pi-ai';

// Start with Claude
const claude = getModel('anthropic', 'claude-sonnet-4-5');
const context: Context = {
  messages: []
};

context.messages.push({ role: 'user', content: 'What is 25 * 18?' });
const claudeResponse = await complete(claude, context, {
  thinkingEnabled: true
});
context.messages.push(claudeResponse);

// Switch to GPT - it will see Claude's thinking as <thinking> tagged text
const gpt = getModel('openai', 'gpt-5.1-codex');
context.messages.push({ role: 'user', content: 'Is that correct?' });
const gptResponse = await complete(gpt, context);
context.messages.push(gptResponse);

// Switch to Gemini
const gemini = getModel('google', 'gemini-2.5-flash');
context.messages.push({ role: 'user', content: 'What was the question?' });
const geminiResponse = await complete(gemini, context);

// Serialize context to JSON (for storage, transfer, etc.)
const serialized = JSON.stringify(context);

// Later: deserialize and continue with any model
const restored: Context = JSON.parse(serialized);
restored.messages.push({ role: 'user', content: 'Summarize our conversation' });
const continuation = await complete(claude, restored);
```

### Structured split tool results 结构化拆分工具结果

#### 核心思想：将工具返回结果拆分为“给 LLM 看的”和“给 UI 显示的”

大多数统一 LLM API 只让工具返回一段文本/JSON 给 LLM，但这段文本不一定包含 UI 需要展示的所有信息（例如图表、富文本）。开发者不得不**解析文本输出再重组 UI 数据**，很麻烦。

pi-ai 允许工具同时返回：

- **`output`**（或 content 中的 `text` 块）→ 给 LLM 理解使用。
- **`details`**（或额外的 `image` 块）→ 直接供 UI 渲染，无需再解析。

并且：

- 工具参数通过 **TypeBox schema + AJV** 自动校验，失败时给出详细错误。
- 可以返回**图片附件**（转成 base64 及 MIME 类型），以各提供商原生格式传递。

#### 简单总结

> pi-ai 在工具调用上做了两件大多数库没做的事：**把工具返回内容分成“LLM 逻辑部分”和“UI 展示部分”**，并且能在工具参数**流式传输过程中就部分解析 JSON** 给 UI 实时预览。

### Minimal agent scaffold 最小代理支架

pi-ai 提供了一个[代理循环](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/agent/agent-loop.ts)来处理完整的流程编排：处理用户消息、执行工具调用、将结果反馈给 LLM，并重复此过程，直到模型无需工具调用即可生成响应。该循环还支持通过回调进行消息排队：每次循环结束后，它会请求队列中的消息，并在下一次助手响应之前注入这些消息。该循环会为所有操作发出事件，从而可以轻松构建响应式 UI。

代理循环不允许您指定最大步数或类似其他统一 LLM API 中常见的参数。我从未发现过需要这些参数的场景，所以为什么要添加它们呢？循环会一直运行，直到代理发出完成指令。不过，除了循环之外， [pi-agent-core](https://github.com/badlogic/pi-mono/tree/main/packages/agent)还提供了一个 `Agent` 类，其中包含一些真正有用的功能：状态管理、简化的事件订阅、两种模式（一次一条或全部同时）的消息队列、附件处理（图像、文档）以及传输抽象，允许您直接运行代理或通过代理运行代理。







## [pi-tui](https://github.com/badlogic/pi-mono/tree/main/packages/tui)

一个极简的终端 UI 框架，具有差异化渲染、同步输出以实现（几乎）无闪烁的更新，以及具有自动完成和 Markdown 渲染功能的编辑器等组件。



## [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

将所有内容（包括会话管理、自定义工具、主题和项目上下文文件）连接在一起的实际 CLI。

- Runs on Windows, Linux, and macOS (or anything with a Node.js runtime and a terminal)
  可在 Windows、Linux 和 macOS 上运行（或任何具有 Node.js 运行时和终端的操作系统）
- Multi-provider support with mid-session model switching
  支持多提供商，并可在会话期间切换模式。
- Session management with continue, resume, and branching
  会话管理，包括继续、恢复和分支
- Project context files (AGENTS.md) loaded hierarchically from global to project-specific
  项目上下文文件（AGENTS.md）按层级结构从全局到项目特定加载。
- Slash commands for common operations
  常用操作的斜杠命令
- Custom slash commands as markdown templates with argument support
  支持带参数的自定义斜杠命令作为 Markdown 模板
- API key authentication for Claude Pro/Max subscriptions
  Claude Pro/Max 订阅的 API 密钥身份验证
- Custom model and provider configuration via JSON
  通过 JSON 配置自定义模型和提供程序
- Customizable themes with live reload
  可自定义主题，支持实时重载
- Editor with fuzzy file search, path completion, drag & drop, and multi-line paste
  编辑器具备模糊文件搜索、路径自动补全、拖放和多行粘贴功能
- Message queuing while the agent is working
  代理工作时消息排队
- Image support for vision-capable models
  支持具备视觉功能的模型的图像支持
- HTML export of sessions
  会话的 HTML 导出
- Headless operation via JSON streaming and RPC mode
  通过 JSON 流和 RPC 模式进行无头操作
- Full cost and token tracking
  完整成本和代币追踪