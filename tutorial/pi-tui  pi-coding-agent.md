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