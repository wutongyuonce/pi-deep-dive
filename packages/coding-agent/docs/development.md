# 开发

参见 [AGENTS.md](../../../AGENTS.md) 了解更多指导。

## 环境设置

```bash
git clone https://github.com/earendil-works/pi-mono
cd pi-mono
npm install
npm run build
```

从源码运行：

```bash
/path/to/pi-mono/pi-test.sh
```

该脚本可以从任何目录运行。Pi 会保持调用者的当前工作目录。

## Fork / 品牌重命名

通过 `package.json` 配置：

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

修改 `name`、`configDir` 和 `bin` 字段以适配你的 fork。这会影响 CLI 横幅、配置路径和环境变量名称。

## 路径解析

三种执行模式：npm install、独立二进制文件、tsx 源码运行。

**始终使用 `src/config.ts`** 来获取包资源：

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

切勿直接使用 `__dirname` 来获取包资源。

## 调试命令

`/debug`（隐藏命令）写入 `~/.pi/agent/pi-debug.log`：
- 带 ANSI 码的渲染 TUI 行
- 发送给 LLM 的最后几条消息

## 测试

```bash
./test.sh                         # 运行非 LLM 测试（无需 API 密钥）
npm test                          # 运行所有测试
npm test -- test/specific.test.ts # 运行指定测试
```

## 项目结构

```
packages/
  ai/           # LLM 提供者抽象层
  agent/        # Agent 循环与消息类型
  tui/          # 终端 UI 组件
  coding-agent/ # CLI 和交互模式
```
