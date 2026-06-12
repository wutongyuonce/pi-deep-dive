## ts

TypeScript 是 JavaScript 的"加强版"，它在 JavaScript 基础上加了**类型标注**。
写代码时声明变量是什么类型（字符串、数字、对象等），编译器会在运行前帮你检查错误。

举个例子：

```typescript
// JavaScript 写法（没有类型标注）
function add(a, b) {
  return a + b;
}

// TypeScript 写法（加了类型标注，a 和 b 必须是数字）
function add(a: number, b: number): number {
  return a + b;
}
```

**只有类型相关的语法（泛型、类型注解、`as`、`satisfies` 等）是 TS 特有的，其余所有控制流、内置对象、异步模式等都属于 JavaScript。**

### 类型系统

TypeScript 的类型标注只在开发阶段有用，编译成 JavaScript 后会被去掉，运行时跟普通 JS 一样。因此 TypeScript 的类型系统是**编译时**的，它主要保护：

- 防止**类型不匹配**（如把字符串传给期望数字的参数）。
- 捕获**拼写错误**或访问不存在的属性。
- 确保函数调用时**参数数量和形状正确**。
- 提供**智能提示**和**重构安全**。

但它无法保护**运行时**的数据安全——比如从 API、JSON.parse、用户输入等来源获得的数据，TypeScript 会盲目信任你声明的类型，实际值可能完全不符合。

**Zod 能帮它做的事情**：

- 在**运行时**验证数据并给出明确的错误信息。
- 允许你定义与 TypeScript 类型**同步**的 schema（`z.object({...})`），既用于运行时校验，又自动推导出静态类型。
- 对数据进行**转换/净化**（如将字符串 `"123"` 转为数字 `123`），确保数据真正符合类型要求。
- 提供 `.parse()`（失败抛异常）或 `.safeParse()`（返回结果对象），让你安全地处理外部数据。

#### 1、只使用 TypeScript（编译时检查，运行时无保护）

```typescript
// 定义类型
interface User {
  id: number;
  name: string;
  email: string;
}

// 一个需要 User 对象的函数
function sendWelcomeEmail(user: User) {
  console.log(`Sending email to ${user.email}`);
}

// 模拟从 API 获取的数据（实际运行时是 JSON.parse 的结果）
const rawData = JSON.parse(`{"id": "123", "name": "Alice", "email": "alice@example.com"}`);

// TypeScript 会信任我们声明的类型，但实际 rawData.id 是字符串 "123"
sendWelcomeEmail(rawData as User);  // 编译通过，但运行时可能出错
```

**问题**：TypeScript 无法阻止运行时的错误类型数据传入，因为类型断言 `as User` 绕过了检查。如果不用 `as User` 断言，依然能通过 TypeScript 编译，因为 `JSON.parse(...)` 的返回值类型是 `any`，而 `any` 类型可以赋值给任何类型（包括 `User`）。

#### 2、TypeScript + Zod 合作（最佳实践）

在程序边界处用 Zod 验证，通过后得到类型安全的值，后续逻辑全用 TypeScript 类型保护。

```typescript
import { z } from 'zod';

// 1. 定义 schema（一份定义，同时用于运行时验证和静态类型）
const UserSchema = z.object({
  id: z.number(),
  name: z.string().min(1),
  email: z.string().email(),
  // 可选字段可以有默认值
  role: z.enum(['admin', 'user']).default('user'),
});
type User = z.infer<typeof UserSchema>;

// 2. 一个需要 User 的业务函数（只依赖 TypeScript 类型）
function updateUserProfile(user: User, newName: string): User {
  return { ...user, name: newName };
}

// 3. 在“边界”处理外部数据（如 API 请求）
async function handleRequest(rawBody: unknown) {
  // 运行时验证
  const validationResult = UserSchema.safeParse(rawBody);
  if (!validationResult.success) {
    // 可以返回 400 错误，并打印详细错误
    console.error(validationResult.error);
    return { status: 400, body: 'Invalid user data' };
  }

  // 从这里开始，validUser 的类型就是 User，TypeScript 会保证后续代码的类型安全
  const validUser = validationResult.data;

  // 安全地调用业务函数
  const updated = updateUserProfile(validUser, 'New Name');
  
  return { status: 200, body: updated };
}

// 测试调用
handleRequest(JSON.parse(`{"id": 123, "name": "Alice", "email": "alice@example.com"}`));
// 成功：因为 id 是数字

handleRequest(JSON.parse(`{"id": "123", "name": "Alice", "email": "alice@example.com"}`));
// 失败：id 不是数字，返回 400
```

### 类型声明关键字

#### let / const

`let` `const` 用于声明一个**块级作用域**的变量/常量。基本语法如下：

```
let/const 变量名: 类型 = 初始值;
```

const 声明时**必须赋初始值**，禁止重新赋值；let 可以先声明后赋值，允许重新赋值

const **允许对象/数组内容修改**（const 只保证变量引用不变，不保证内部属性不变）

- **默认使用 `const`**：除非你需要对变量重新赋值（如循环计数器、累加器等），否则优先用 `const`。这能明确表达“这个变量不会改变”，避免意外修改。
- **使用 `let`**：当变量的值确实会变化时（例如 `let sum = 0; sum += x;`）。
- **避免使用 `var`**：在 TypeScript/现代 JavaScript 中，不再需要 `var`。

#### interface / type

```text
                TypeScript 类型系统
                        │
                        │  核心判断规则
                        ▼
                 结构兼容（structural typing）
              “看起来像，就可以当成那个类型”
                        │
        ┌───────────────┼───────────────┐
        │               │               │
        ▼               ▼               ▼
     type            interface        implements
   类型别名            接口            类上的显式声明
        │               │               │
        │               │               │
        │               │               └── 只用于 class
        │               │                   作用：让编译器检查类是否满足接口
        │               │
        │               └── 常用于对象结构、可扩展接口、声明合并
        │
        └── 常用于函数签名、联合类型、交叉类型、别名
```

1、`type` 就是**给一个类型起别名**。

```ts
type User = {
  id: string;
  name: string;
};

type Add = (a: number, b: number) => number;
```

它适合：
- 函数类型
- 联合类型
- 交叉类型
- 一次性类型别名

比如：

```ts
type Status = "idle" | "running" | "done";
```

这个只能用 `type`，不能用 `interface`。

2、`interface` 主要是**描述对象/类实例长什么样**。

```ts
interface User {
  id: string;
  name: string;
}
```

它适合：
- 对象结构
- class 的实例形状
- 需要被扩展的协议
- 声明合并

比如：

```ts
interface User {
  id: string;
}

interface User {
  name: string;
}
```

会自动合并成：

```ts
interface User {
  id: string;
  name: string;
}
```

这就是 `interface` 的一个重要特性，`type` 做不到。

3、`implements` 是是 **class 上的检查语法**。

```ts
interface User {
  id: string;
  name: string;
}

class Person implements User {
  id: string;
  name: string;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }
}
```

它的作用是：

```text
“这个类承诺自己符合 User 接口，请编译器帮我检查”
```

注意：
- `implements` 只给 `class` 用
- 它不是类型兼容的根本依据
- 真正的兼容依据仍然是结构兼容

#### 类型断言、交叉类型

```ts
const code = (error as Error & { code?: unknown }).code;
```

拆开看：

* error as ... 类型断言：我知道 TS 认为 error 的类型不完全匹配，但我确信可以这样用 

* Error & { code?: unknown } 交叉类型：在 Error 的基础上加一个可选的 code 字段，类型是 unknown 
* code?: unknown ? = 可选（可能不存在）， unknown = 不确定是 string/number/其他 
* .code 读取这个字段，不存在就是 undefined

#### 泛型 `<T>`？

泛型是一种"参数化的类型"，让函数/类可以处理不同类型的数据，同时保持类型安全：

```typescript
// 没有泛型：只能处理字符串数组
function getFirst(arr: string[]): string {
  return arr[0];
}

// 有泛型：可以处理任意类型的数组，返回值类型与数组元素类型一致
function getFirst<T>(arr: T[]): T {
  return arr[0];
}

// 使用时 TypeScript 自动推断类型
getFirst([1, 2, 3])       // T 被推断为 number，返回 number
getFirst(["a", "b"])      // T 被推断为 string，返回 string
```

在 pi 的代码中，`EventStream<T, R>` 的 `T` 是事件类型，`R` 是最终结果类型。

### AsyncIterable（异步可迭代）？

普通数组可以用 `for...of` 遍历：

```typescript
for (const item of [1, 2, 3]) {
  console.log(item);  // 1, 2, 3
}
```

如果某个类 implements AsyncIterable<T>，就要实现 [Symbol.asyncIterator]() 方法，从而能被 for await...of 遍历：

```typescript
// 流式返回的数据不是一个完整数组，而是一个"管道"，数据陆续到达
for await (const chunk of openaiStream) {
  console.log(chunk);  // 每收到一小块数据就立即处理
}
```

### AbortController / AbortSignal（JS）

这是 JavaScript 的标准 API，用于取消正在进行的异步操作：

```typescript
// 创建一个控制器
const controller = new AbortController();

// 把它的 signal 传给异步操作
fetch("https://api.example.com", { signal: controller.signal });

// 2 秒后取消
setTimeout(() => controller.abort(), 2000);
// controller.abort() 会把 signal.aborted 设为 true
// fetch 检测到后会立即中断网络请求

function fetch(url, options) {
  const { signal } = options;
  return new Promise((resolve, reject) => {
    // 内部监听 abort 事件
    if (signal) {
      signal.addEventListener('abort', () => {
        // 中断网络请求
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }
    // ... 发起真实网络请求
  });
}
```

### IIFE（立即执行函数表达式）

`(async () => { ... })()` 这种写法是"定义一个函数并立即执行它"：

```typescript
// 普通函数定义 + 调用
async function doWork() {
  // 做一些异步工作...
}
doWork();  // 调用

// IIFE 写法：定义和调用合二为一
(async () => {
  // 做一些异步工作...
})();
```

### function* 和 yield

`yield` 用在"生成器函数" function* 里，每次产出一个值后暂停，等下次被请求时再继续：

```typescript
// 生成器函数（注意 function* 星号）
function* count() {
  yield 1;  // 产出 1，暂停
  yield 2;  // 产出 2，暂停
  yield 3;  // 产出 3，暂停
}

for (const n of count()) {
  console.log(n);  // 1, 2, 3
}

// 在流式场景中，yield 让消费者"来一个处理一个"，
// 而不是等所有数据到齐才开始处理。
```

### "点火即忘"（fire and forget）模式

```typescript
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(...):
```

`async` 函数返回 `Promise`，但 `agentLoop()` 这里需要返回 `EventStream`（一个可以持续产出多个值的流）。所以函数本身是同步的——它创建流、启动后台任务、**立刻**返回流。

```typescript
void runAgentLoop(...).then((messages) => {
    stream.end(messages);
});
```

`agentLoop()` 内的这段代码是 fire and forget 模式：

- `runAgentLoop()` 是 async 异步的，返回 `Promise`
- `void` 表示"我不等它完成，也不关心返回值"

整个函数的执行顺序是：

```
agentLoop() 被调用
  1. const stream = createAgentStream()     ← 同步，创建空流
  2. void runAgentLoop(...).then(...)        ← 同步，启动后台任务（不等待）
  3. return stream                           ← 同步，立刻返回流
  
  （后台）runAgentLoop 执行中...
    → 每产生一个事件就 stream.push(event)    ← 流里有数据了
    → 循环结束 → stream.end(messages)        ← 流关闭
```

调用方拿到 `stream` 后可以立刻 `for await` 开始消费，事件会陆续到来。

如果这么写：

```typescript
async function agentLoop(): Promise<EventStream<...>> {
    await runAgentLoop(...);  // 调用方必须 await 才能拿到 stream
    return stream;            // 但此时循环已经结束了！
}

// 当前的写法（同步启动，异步填充）
function agentLoop(): EventStream<...> {
    void runAgentLoop(...);   // 后台启动，不等待
    return stream;            // 立刻返回，调用方可以边循环边消费
}
```

关键区别：用 `async` 的话，调用方必须 `await agentLoop()` 才能拿到 `stream`，但 `await` 会等到整个循环结束——那就失去了"实时流式消费"的意义。当前写法让调用方拿到流时，循环还在后台跑着，事件边产生边推入流。

## ...xxx 展开语法 spread syntax
### 在数组里
```ts
[...prompts]
```
意思是把 prompts 这个数组里的元素一个个展开，放进新数组。

例如：

```ts
const prompts = ["a", "b"];
const x = [...prompts];
// x = ["a", "b"]
```
它的作用通常是： 复制数组 。

再看这个：

```ts
[...context.messages, ...prompts]
```

意思是把两个数组拼起来：

```ts
const a = [1, 2];
const b = [3, 4];
const c = [...a, ...b];
// c = [1, 2, 3, 4]
```

### 在对象里

```ts
{
  ...context,
  messages: ...
}
```

意思是把 context 对象的所有字段展开到一个新对象里。

例如：

```ts
const context = {
  systemPrompt: "hi",
  messages: [1, 2],
  tools: ["t1"],
};

const x = {
  ...context,
  messages: [1, 2, 3],
};
```

结果相当于：

```ts
const x = {
  systemPrompt: "hi",
  messages: [1, 2, 3], // 覆盖原来的 messages
  tools: ["t1"],
};
```

注意： 后面同名字段会覆盖前面的字段 。