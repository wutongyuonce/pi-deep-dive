# Windows 环境配置

Pi 在 Windows 上需要一个 bash shell。按以下顺序依次查找：

1. 自定义路径（来自 `~/.pi/agent/settings.json`）
2. Git Bash（`C:\Program Files\Git\bin\bash.exe`）
3. PATH 环境变量中的 `bash.exe`（Cygwin、MSYS2、WSL）

对大多数用户而言，[Git for Windows](https://git-scm.com/download/win) 已经足够。

## 自定义 Shell 路径

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
