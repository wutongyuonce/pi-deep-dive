# 终端设置

Pi 使用 [Kitty 键盘协议](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) 来实现可靠的修饰键检测。大多数现代终端都支持该协议，但有些需要额外配置。

## Kitty、iTerm2

开箱即用，无需配置。

## Apple Terminal（苹果终端）

Pi 会在可用时启用增强键报告。如果 Terminal.app 仍然为 `Shift+Enter` 发送普通回车键，pi 会使用本地 macOS 修饰键回退方案，将该回车视为 `Shift+Enter`。

此回退方案仅在 pi 与 Terminal.app 运行在同一台 Mac 上时有效。通过远程 SSH 连接时无法检测本地键盘。

## Ghostty

在 Ghostty 配置文件中添加（macOS 路径为 `~/Library/Application Support/com.mitchellh.ghostty/config`，Linux 路径为 `~/.config/ghostty/config`）：

```
keybind = alt+backspace=text:\x1b\x7f
```

旧版 Claude Code 可能已添加过以下 Ghostty 映射：

```
keybind = shift+enter=text:\n
```

该映射发送的是原始换行字节。在 pi 内部，这无法与 `Ctrl+J` 区分，因此 tmux 和 pi 将无法识别到真正的 `shift+enter` 按键事件。

如果你仅因 Claude Code 2.x 或更新版本而添加了该映射，可以将其移除，除非你想在 tmux 中使用 Claude Code（在 tmux 中确实需要该 Ghostty 映射）。

如果你希望通过该映射使 `Shift+Enter` 在 tmux 中继续正常工作，可以在 `~/.pi/agent/keybindings.json` 中将 `ctrl+j` 添加到 pi 的 `newLine` 按键绑定中：

```json
{
  "newLine": ["shift+enter", "ctrl+j"]
}
```

## WezTerm

创建 `~/.wezterm.lua`：

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

## VS Code（集成终端）

`keybindings.json` 文件位置：
- macOS：`~/Library/Application Support/Code/User/keybindings.json`
- Linux：`~/.config/Code/User/keybindings.json`
- Windows：`%APPDATA%\\Code\\User\\keybindings.json`

在 `keybindings.json` 中添加以下内容以启用 `Shift+Enter` 进行多行输入：

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

## Windows Terminal

在 `settings.json` 中添加（按 Ctrl+Shift+, 或通过设置 → 打开 JSON 文件）以转发 pi 使用的修饰过的 Enter 键：

```json
{
  "actions": [
    {
      "command": { "action": "sendInput", "input": "\u001b[13;2u" },
      "keys": "shift+enter"
    },
    {
      "command": { "action": "sendInput", "input": "\u001b[13;3u" },
      "keys": "alt+enter"
    }
  ]
}
```

- `Shift+Enter` 插入新行。
- Windows Terminal 默认将 `Alt+Enter` 绑定为全屏切换。这会阻止 pi 接收 `Alt+Enter` 进行后续任务排队。
- 将 `Alt+Enter` 重新映射为 `sendInput` 可以将真实的按键组合转发给 pi。

如果你已经有 `actions` 数组，直接将上述对象添加到其中即可。如果旧的全屏行为仍然生效，请完全关闭并重新打开 Windows Terminal。

## xfce4-terminal、terminator

这些终端的转义序列支持有限。`Ctrl+Enter` 和 `Shift+Enter` 等修饰过的 Enter 键无法与普通 `Enter` 区分，导致自定义按键绑定（如 `submit: ["ctrl+enter"]`）无法工作。

为获得最佳体验，请使用支持 Kitty 键盘协议的终端：
- [Kitty](https://sw.kovidgoyal.net/kitty/)
- [Ghostty](https://ghostty.org/)
- [WezTerm](https://wezfurlong.org/wezterm/)
- [iTerm2](https://iterm2.com/)
- [Alacritty](https://github.com/alacritty/alacritty)（需要编译时启用 Kitty 协议支持）

## IntelliJ IDEA（集成终端）

内置终端的转义序列支持有限。在 IntelliJ 终端中，Shift+Enter 无法与 Enter 区分。

如果希望硬件光标可见，可以在运行 pi 之前设置 `PI_HARDWARE_CURSOR=1`（默认关闭以保证兼容性）。

建议使用独立的终端模拟器以获得最佳体验。
