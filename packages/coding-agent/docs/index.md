# Pi 文档

Pi 是一个极简的终端编码工具。它保持核心小巧，同时通过 TypeScript 扩展、技能、提示模板、主题和 Pi 包进行扩展。

## 快速开始

使用 npm 安装 Pi：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 在安装期间禁用依赖的生命周期脚本。Pi 的正常 npm 安装不需要安装脚本。

在 Linux 或 macOS 上，也可以使用安装脚本：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

要卸载 pi 本身，对于 curl 和 npm 安装均使用 npm：

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

对于 pnpm、Yarn 或 Bun 安装，使用对应的全局移除命令：`pnpm remove -g @earendil-works/pi-coding-agent`、`yarn global remove @earendil-works/pi-coding-agent` 或 `bun uninstall -g @earendil-works/pi-coding-agent`。

然后在项目目录中运行：

```bash
pi
```

在启动 pi 之前设置 API 密钥（例如 `ANTHROPIC_API_KEY`），或使用 `/login` 存储凭据。

有关首次运行的完整流程，请参阅[快速开始](quickstart.md)。

## 从这里开始

- [快速开始](quickstart.md) - 安装、认证并运行第一个会话。
- [使用 Pi](usage.md) - 交互模式、斜杠命令、上下文文件和 CLI 参考。
- [提供商](providers.md) - 内置提供商的 API 密钥设置。
- [设置](settings.md) - 全局和项目设置。
- [快捷键](keybindings.md) - 默认快捷键和自定义键绑定。
- [会话](sessions.md) - 会话管理、分支和树导航。
- [上下文压缩](compaction.md) - 上下文压缩和分支摘要。

## 自定义

- [扩展](extensions.md) - 用于工具、命令、事件和自定义 UI 的 TypeScript 模块。
- [技能](skills.md) - 可复用的按需能力代理技能。
- [提示模板](prompt-templates.md) - 通过斜杠命令展开的可复用提示。
- [主题](themes.md) - 内置和自定义终端主题。
- [Pi 包](packages.md) - 打包和分享扩展、技能、提示和主题。
- [自定义模型](models.md) - 为支持的提供商 API 添加模型条目。
- [自定义提供商](custom-provider.md) - 实现自定义 API。

## 编程使用

- [SDK](sdk.md) - 在 Node.js 应用中嵌入 pi。
- [RPC 模式](rpc.md) - 通过 stdin/stdout JSONL 集成。
- [JSON 事件流模式](json.md) - 带结构化事件的打印模式。
- [TUI 组件](tui.md) - 为扩展构建自定义终端 UI。

## 参考

- [会话格式](session-format.md) - JSONL 会话文件格式、条目类型和 SessionManager API。

## 平台配置

- [Windows](windows.md)
- [Android 上的 Termux](termux.md)
- [tmux](tmux.md)
- [终端设置](terminal-setup.md)
- [Shell 别名](shell-aliases.md)

## 开发

- [开发指南](development.md) - 本地设置、项目结构和调试。
