## 根目录配置文件

本仓库采用 monorepo 结构，根目录下的配置文件作用于整个仓库的所有子包。

### `.npmrc`

npm 配置文件，控制 `npm install` 等命令的默认行为。手写，存于仓库根目录。

```ini
save-exact=true
min-release-age=2
```

| 字段 | 值 | 说明 |
|------|-----|------|
| `save-exact=true` | - | 执行 `npm install <pkg>` 时使用精确版本号（如 `1.2.3`），而非范围版本（如 `^1.2.3`）。这是仓库的安全策略，配合 `check-pinned-deps.mjs` 脚本确保所有直接依赖版本锁定 |
| `min-release-age=2` | - | npm 要求新发布的包至少存在 2 天后才允许安装，防止刚发布的恶意包被误装 |

### `biome.json`

代码格式化与 lint 工具 [Biome](https://biomejs.dev/) 的配置文件。手写，但 `biome check --write` 会自动格式化代码。

```json
{
  "$schema": "https://biomejs.dev/schemas/2.3.5/schema.json",
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": {
        "noNonNullAssertion": "off",
        "useConst": "error",
        "useNodejsImportProtocol": "off"
      },
      "suspicious": {
        "noExplicitAny": "off",
        "noControlCharactersInRegex": "off",
        "noEmptyInterface": "off"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "indentWidth": 3,
    "lineWidth": 120
  },
  "files": {
    "includes": [
      "packages/*/src/**/*.ts",
      "packages/*/test/**/*.ts",
      "packages/coding-agent/examples/**/*.ts",
      "!packages/mom/data/**/*"
    ]
  }
}
```

| 字段 | 说明 |
|------|------|
| `$schema` | JSON Schema 地址，编辑器可据此获得自动补全和校验 |
| `linter.enabled: true` | 启用代码检查 |
| `linter.rules.recommended: true` | 使用 Biome 推荐的规则集 |
| `style.noNonNullAssertion: "off"` | 关闭禁止 `!` 非空断言，允许 `foo!.bar` 这种写法 |
| `style.useConst: "error"` | 强制能用 `const` 的地方不用 `let` |
| `style.useNodejsImportProtocol: "off"` | 不强制 `node:fs` 这种协议写法，允许直接用 `import from "fs"` |
| `suspicious.noExplicitAny: "off"` | 允许使用 `any` 类型 |
| `formatter.indentStyle: "tab"` | 使用 Tab 缩进，每个 Tab = 3 个空格宽度 |
| `formatter.lineWidth: 120` | 每行最多 120 个字符 |

### `package-lock.json`

npm 依赖锁定文件，由 `npm install` 自动生成和维护。**不要手动编辑**。

与 `packages/coding-agent/npm-shrinkwrap.json` 的区别：

| 文件 | 作用域 | 是否发布 |
|------|--------|----------|
| `package-lock.json` | 根目录，记录整个 monorepo 所有包的所有依赖版本 | 不发布（`"private": true`） |
| `npm-shrinkwrap.json` | `coding-agent` 包独享，只包含发布所需的依赖 | 随包发布到 npm |

根目录的 `package-lock.json` 是整个仓库的"完整依赖清单"，包含 `packages/` 下所有子包的依赖。当开发者执行 `npm install` 时，npm 根据此文件安装确切的版本，保证所有开发者环境一致。

注意：根 `package.json` 中有 `"private": true`，所以这个包不会发布，`package-lock.json` 也不会出现在 npm 上。

### `tsconfig.base.json`

TypeScript 编译的基础配置，所有子包共享此配置。手写，各子包的 `tsconfig.build.json` 通过 `"extends": "../../tsconfig.base.json"` 继承。

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "erasableSyntaxOnly": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "inlineSources": true,
    "moduleResolution": "Node16",
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,
    "types": ["node"]
  }
}
```

| 字段 | 说明 |
|------|------|
| `target: "ES2022"` | 编译输出 ES2022 标准的 JavaScript |
| `module: "Node16"` | 使用 Node.js 16 的模块解析规则 |
| `strict: true` | 启用所有严格类型检查选项 |
| `erasableSyntaxOnly: true` | 只允许"可擦除"的 TypeScript 语法（编译后不残留）。禁止 `enum`、`namespace`、参数属性等需要 JS 发射的语法 |
| `declaration: true` | 生成 `.d.ts` 类型声明文件 |
| `declarationMap: true` | 生成 `.d.ts.map` 源映射，方便从类型定义跳转到源码 |
| `sourceMap: true` | 生成 `.js.map` 源码映射，调试时可以看到 TS 源码 |
| `inlineSources: true` | 将源码嵌入到 source map 中 |
| `allowImportingTsExtensions: true` | 允许 `import from "./foo.ts"` 这种写法 |
| `rewriteRelativeImportExtensions: true` | 编译时将 `.ts` 自动重写为 `.js`（如 `./foo.ts` → `./foo.js`） |
| `experimentalDecorators: true` | 启用装饰器语法支持（框架内部使用） |
| `useDefineForClassFields: false` | 使用传统的类字段初始化方式 |

### `tsconfig.json`

根目录的 TypeScript 配置，主要用于编辑器（VS Code）的类型检查。手写。

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "paths": {
      "@earendil-works/pi-ai": ["./packages/ai/src/index.ts"],
      "@earendil-works/pi-ai/*": ["./packages/ai/src/*.ts", "./packages/ai/src/providers/*.ts"],
      "@earendil-works/pi-agent-core": ["./packages/agent/src/index.ts"],
      "@earendil-works/pi-agent-core/*": ["./packages/agent/src/*"],
      "@earendil-works/pi-coding-agent": ["./packages/coding-agent/src/index.ts"],
      "@earendil-works/pi-coding-agent/hooks": ["./packages/coding-agent/src/core/hooks/index.ts"],
      "@earendil-works/pi-coding-agent/*": ["./packages/coding-agent/src/*"],
      "@earendil-works/pi-tui": ["./packages/tui/src/index.ts"],
      "@earendil-works/pi-tui/*": ["./packages/tui/src/*"],
      "typebox": ["./node_modules/typebox"]
    }
  },
  "include": ["packages/*/src/**/*", "packages/*/test/**/*", "packages/coding-agent/examples/**/*"],
  "exclude": ["**/dist/**"]
}
```

| 字段 | 说明 |
|------|------|
| `extends` | 继承 `tsconfig.base.json` 的所有配置 |
| `noEmit: true` | 不生成编译产物，仅做类型检查。编译由各子包的 `tsconfig.build.json` 负责 |
| `paths` | 路径别名映射，让 `import "@earendil-works/pi-ai"` 时直接指向源码，而非编译后的 `dist/`。这使得编辑器和 lint 工具能正确解析跨包引用 |

### `pi-test.sh` / `pi-test.ps1` / `pi-test.bat`

本地开发时运行 pi CLI 的快捷脚本，分别支持 Linux/macOS、Windows PowerShell、Windows CMD。手写。

```bash
# pi-test.sh
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 支持 --no-env 参数：清除所有 API 密钥环境变量
NO_ENV=false
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  fi
done

if [[ "$NO_ENV" == "true" ]]; then
  unset ANTHROPIC_API_KEY
  unset OPENAI_API_KEY
  # ... 清除所有 API 密钥
  echo "Running without API keys..."
fi

# 用 tsx 直接运行源码（无需编译）
"$SCRIPT_DIR/node_modules/.bin/tsx" --tsconfig "$SCRIPT_DIR/tsconfig.json" \
  "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
```

| 字段 | 说明 |
|------|------|
| `--no-env` | 可选参数。运行时清除所有 API 密钥环境变量，防止误用生产密钥 |
| `tsx` | 使用 TypeScript Execute（`tsx`）直接运行 TypeScript 源码，无需先编译 |
| `packages/coding-agent/src/cli.ts` | pi CLI 的源码入口 |

这三个脚本是跨平台的"快捷启动方式"：

| 脚本 | 平台 | 启动方式 |
|------|------|----------|
| `pi-test.sh` | Linux / macOS | 终端直接调用：`./pi-test.sh` |
| `pi-test.ps1` | Windows PowerShell | `.\pi-test.ps1` |
| `pi-test.bat` | Windows CMD | 直接双击或 `pi-test.bat`，内部调用 PowerShell 脚本 |

### `test.sh`

运行测试的专用脚本。手写。

```bash
#!/usr/bin/env bash
set -e

# 备份并移除 auth.json（防止测试误用真实认证信息）
AUTH_FILE="$HOME/.pi/agent/auth.json"
AUTH_BACKUP="$HOME/.pi/agent/auth.json.bak"

# 退出时自动恢复 auth.json
trap cleanup EXIT

if [[ -f "$AUTH_FILE" ]]; then
    mv "$AUTH_FILE" "$AUTH_BACKUP"
fi

# 跳过本地 LLM 测试（ollama、lmstudio）
export PI_NO_LOCAL_LLM=1

# 清除所有 API 密钥环境变量
unset ANTHROPIC_API_KEY
unset OPENAI_API_KEY
# ...

# 运行测试
npm test
```

| 特性 | 说明 |
|------|------|
| `auth.json` 备份 | 测试前将真实认证文件移到备份位置，退出时自动恢复 |
| `PI_NO_LOCAL_LLM=1` | 跳过需要本地 LLM（如 Ollama）的测试 |
| 清除 API 密钥 | 确保测试不会意外调用真实 LLM API 产生费用 |
| `trap cleanup EXIT` | 即使测试中途崩溃，也能恢复 auth.json |

这个脚本确保测试环境是"干净"的：没有 API 密钥、没有本地 LLM、没有认证信息，所有测试都使用模拟（faux）provider。
