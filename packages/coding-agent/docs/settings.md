# 设置

Pi 使用 JSON 格式的设置文件，项目设置会覆盖全局设置。

| 位置 | 范围 |
|----------|-------|
| `~/.pi/agent/settings.json` | 全局（所有项目） |
| `.pi/settings.json` | 项目（当前目录） |

直接编辑文件或使用 `/settings` 命令进行常用选项设置。

## 所有设置

### 模型与思考

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | 默认提供商（例如 `"anthropic"`、`"openai"`） |
| `defaultModel` | string | - | 默认模型 ID |
| `defaultThinkingLevel` | string | - | `"off"`、`"minimal"`、`"low"`、`"medium"`、`"high"`、`"xhigh"` |
| `hideThinkingBlock` | boolean | `false` | 隐藏输出中的思考块 |
| `thinkingBudgets` | object | - | 每个思考级别的自定义令牌预算 |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI 与显示

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | 主题名称（`"dark"`、`"light"` 或自定义） |
| `quietStartup` | boolean | `false` | 隐藏启动标题 |
| `collapseChangelog` | boolean | `false` | 更新后显示精简版更新日志 |
| `enableInstallTelemetry` | boolean | `true` | 首次安装或通过更新日志检测到更新后，发送匿名安装/更新版本 ping。这不控制更新检查 |
| `doubleEscapeAction` | string | `"tree"` | 双击 Escape 的操作：`"tree"`、`"fork"` 或 `"none"` |
| `treeFilterMode` | string | `"default"` | `/tree` 的默认过滤器：`"default"`、`"no-tools"`、`"user-only"`、`"labeled-only"`、`"all"` |
| `editorPaddingX` | number | `0` | 输入编辑器的水平内边距（0-3） |
| `autocompleteMaxVisible` | number | `5` | 自动完成下拉菜单中最大可见项数（3-20） |
| `showHardwareCursor` | boolean | `false` | 显示终端光标 |

### 遥测与更新检查

`enableInstallTelemetry` 仅控制向 `https://pi.dev/api/report-install` 发送的匿名安装/更新 ping。退出遥测不会禁用更新检查；Pi 仍然可以获取 `https://pi.dev/api/latest-version` 以查找最新版本。

设置 `PI_SKIP_VERSION_CHECK=1` 可禁用 Pi 版本更新检查。使用 `--offline` 或 `PI_OFFLINE=1` 可禁用所有描述的启动网络操作，包括更新检查、包更新检查和安装/更新遥测。

### 警告

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | 当 Anthropic 订阅认证可能使用付费额外用量时显示警告 |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### 压缩

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | 启用自动压缩 |
| `compaction.reserveTokens` | number | `16384` | 为 LLM 响应预留的令牌数 |
| `compaction.keepRecentTokens` | number | `20000` | 保留的最近令牌数（不进行摘要） |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### 分支摘要

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | 为分支摘要预留的令牌数 |
| `branchSummary.skipPrompt` | boolean | `false` | 在 `/tree` 导航时跳过"摘要分支？"提示（默认为不生成摘要） |

### 重试

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | 启用临时错误时的自动代理级别重试 |
| `retry.maxRetries` | number | `3` | 最大代理级别重试次数 |
| `retry.baseDelayMs` | number | `2000` | 代理级别指数退避的基础延迟（2s, 4s, 8s） |
| `retry.provider.timeoutMs` | number | SDK 默认值 | 提供商/SDK 请求超时（毫秒） |
| `retry.provider.maxRetries` | number | `0` | 提供商/SDK 重试次数 |
| `retry.provider.maxRetryDelayMs` | number | `60000` | 服务器请求延迟的最大等待时间（60s），超过则失败 |

当提供商请求的重试延迟超过 `retry.provider.maxRetryDelayMs`（例如，Google 的"配额将在 5 小时后重置"）时，请求会立即失败并显示信息性错误，而不是静默等待。设置为 `0` 可禁用此上限。

除非明确需要提供商级别的重试，否则请将 `retry.provider.maxRetries` 保持在 `0`。将其设置为大于 `0` 可能导致 SDK/提供商在 Pi 看到错误之前处理超限错误，这可能会在某些情况下阻止代理直到提供商配额重置。

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### 消息投递

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | 引导消息的发送方式：`"all"` 或 `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | 跟进消息的发送方式：`"all"` 或 `"one-at-a-time"` |
| `transport` | string | `"sse"` | 支持多种传输方式的提供商的首选传输协议：`"sse"`、`"websocket"` 或 `"auto"` |

### 终端与图片

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | 在终端中显示图片（如果支持） |
| `terminal.imageWidthCells` | number | `60` | 终端中内联图片的首选宽度（以单元格为单位） |
| `terminal.clearOnShrink` | boolean | `false` | 内容缩小时清除空行（可能导致闪烁） |
| `images.autoResize` | boolean | `true` | 将图片自动调整至最大 2000x2000 |
| `images.blockImages` | boolean | `false` | 阻止所有图片发送到 LLM |

### Shell

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `shellPath` | string | - | 自定义 shell 路径（例如，Windows 上的 Cygwin） |
| `shellCommandPrefix` | string | - | 每个 bash 命令的前缀（例如 `"shopt -s expand_aliases"`） |
| `npmCommand` | string[] | - | 用于 npm 包查找/安装操作的命令 argv（例如 `["mise", "exec", "node@20", "--", "npm"]`） |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` 用于所有 npm 包管理器操作，包括安装、卸载以及 git 包内的依赖安装。用户范围的 npm 包安装在 `~/.pi/agent/npm/` 下；项目范围的 npm 包安装在 `.pi/npm/` 下。请按照进程启动时的确切方式使用 argv 格式的条目。当配置了 `npmCommand` 时，git 包的依赖安装将使用普通的 `install` 命令，以避免在包装器或其他包管理器中传递 npm 专用标志。

### 会话

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `sessionDir` | string | - | 存储会话文件的目录。支持绝对路径、相对路径以及 `~`。 |

```json
{ "sessionDir": ".pi/sessions" }
```

当多个来源指定会话目录时，优先级为 `--session-dir`、`PI_CODING_AGENT_SESSION_DIR`，然后是 `settings.json` 中的 `sessionDir`。

### 模型循环

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Ctrl+P 模型循环的模式（与 `--models` CLI 标志格式相同） |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | 代码块的缩进 |

### 资源

这些设置定义了从何处加载扩展、技能、提示和主题。

`~/.pi/agent/settings.json` 中的路径相对于 `~/.pi/agent` 解析。`.pi/settings.json` 中的路径相对于 `.pi` 解析。支持绝对路径和 `~`。

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `packages` | array | `[]` | 从中加载资源的 npm/git 包 |
| `extensions` | string[] | `[]` | 本地扩展文件路径或目录 |
| `skills` | string[] | `[]` | 本地技能文件路径或目录 |
| `prompts` | string[] | `[]` | 本地提示模板路径或目录 |
| `themes` | string[] | `[]` | 本地主题文件路径或目录 |
| `enableSkillCommands` | boolean | `true` | 将技能注册为 `/skill:name` 命令 |

数组支持 glob 模式和排除项。使用 `!pattern` 排除。使用 `+path` 强制包含精确路径，使用 `-path` 强制排除精确路径。

#### packages

字符串形式从包中加载所有资源：

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

对象形式过滤要加载的资源：

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

有关包管理的详细信息，请参阅 [packages.md](zh/packages.md)。

## 示例

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## 项目覆盖

项目设置（`.pi/settings.json`）覆盖全局设置。嵌套对象会合并：

```json
// ~/.pi/agent/settings.json（全局）
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .pi/settings.json（项目）
{
  "compaction": { "reserveTokens": 8192 }
}

// 结果
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
