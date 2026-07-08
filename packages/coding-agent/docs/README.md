# Pi 中文文档

Pi 是一个极简的终端编码助手，核心保持轻量，通过 TypeScript 扩展、技能（Skills）、提示词模板（Prompt Templates）、主题（Themes）和 Pi 包（Packages）进行扩展。

## 快速开始

使用 npm 安装 Pi：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

```bash
cd /path/to/project
pi
```

完整流程请参阅 [快速开始](quickstart.md)。

## 从这里开始

- [快速开始](quickstart.md) — 安装、认证并运行第一个会话
- [使用 Pi](usage.md) — 交互模式、斜杠命令、上下文文件和 CLI 参考
- [提供商](providers.md) — 内置提供商的 API 密钥配置
- [设置](settings.md) — 全局和项目设置
- [快捷键](keybindings.md) — 默认快捷键和自定义绑定
- [会话](sessions.md) — 会话管理、分支和树导航
- [上下文压缩](compaction.md) — 上下文压缩和分支摘要

## 自定义

- [扩展](extensions.md) — TypeScript 模块，用于工具、命令、事件和自定义 UI
- [技能](skills.md) — 代理技能，提供可复用的按需能力
- [提示词模板](prompt-templates.md) — 可复用的提示词，通过斜杠命令展开
- [主题](themes.md) — 内置和自定义终端主题
- [Pi 包](packages.md) — 打包和分享扩展、技能、提示词和主题
- [自定义模型](models.md) — 为支持的提供商 API 添加模型条目
- [自定义提供商](custom-provider.md) — 实现自定义 API

## 编程式使用

- [SDK](sdk.md) — 在 Node.js 应用中嵌入 pi
- [RPC 模式](rpc.md) — 通过 stdin/stdout JSONL 集成
- [JSON 事件流模式](json.md) — 带结构化事件的打印模式
- [TUI 组件](tui.md) — 为扩展构建自定义终端 UI

## 参考

- [会话格式](session-format.md) — JSONL 会话文件格式、条目类型和 SessionManager API

## 平台配置

- [Windows](windows.md)
- [Termux（Android）](termux.md)
- [tmux](tmux.md)
- [终端设置](terminal-setup.md)
- [Shell 别名](shell-aliases.md)

## 开发

- [开发指南](development.md) — 本地设置、项目结构和调试
