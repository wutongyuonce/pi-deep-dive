### ts 前置知识

#### 什么是 TypeScript？

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

TypeScript 的类型标注只在开发阶段有用，编译成 JavaScript 后会被去掉，运行时跟普通 JS 一样。

#### let / const

`let` `const` 用于声明一个**块级作用域**的变量。基本语法如下：

```
let/const 变量名: 类型 = 初始值;
```

const 声明时**必须赋初始值**，禁止重新赋值；let 可以先声明后赋值，允许重新赋值

const **允许对象/数组内容修改**（const 只保证变量引用不变，不保证内部属性不变）

- **默认使用 `const`**：除非你需要对变量重新赋值（如循环计数器、累加器等），否则优先用 `const`。这能明确表达“这个变量不会改变”，避免意外修改。
- **使用 `let`**：当变量的值确实会变化时（例如 `let sum = 0; sum += x;`）。
- **避免使用 `var`**：在 TypeScript/现代 JavaScript 中，不再需要 `var`。

#### 什么是 interface（接口）？

`interface` 用来定义一个对象"长什么样"，它只描述结构，不产生实际代码：

```typescript
// 定义一个接口：StreamOptions 必须有这些字段
interface StreamOptions {
  temperature?: number;    // ? 表示可选，可以不传
  maxTokens?: number;      // ? 表示可选
  signal?: AbortSignal;    // ? 表示可选，类型是 AbortSignal
  apiKey?: string;         // ? 表示可选，类型是字符串
}
```

#### 什么是泛型 `<T>`？

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

#### 什么是 AsyncIterable（异步可迭代）？

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

#### 什么是 AbortController / AbortSignal？

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

#### 什么是 IIFE（立即执行函数表达式）？

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

#### 什么是 yield？

`yield` 用在"生成器函数"里，每次产出一个值后暂停，等下次被请求时再继续：

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

#### 类型断言、交叉类型

```
const code = (error as Error & { code?: 
unknown }).code;
```

拆开看：

* error as ... 类型断言：我知道 TS 认为 error 的类型不完全匹配，但我确信可以这样用 

* Error & { code?: unknown } 交叉类型：在 Error 的基础上加一个可选的 code 字段，类型是 unknown 
* code?: unknown ? = 可选（可能不存在）， unknown = 不确定是 string/number/其他 
* .code 读取这个字段，不存在就是 undefined