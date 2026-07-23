```ts
interface CronTask {
  id: string;
  schedule: string; // cron 表达式，如 "0 9 * * 1-5"
  task: string;     // 自然语言任务描述
  userId: string;   // 发结果给谁
}

// 配置示例
scheduler.schedule({
  id: "morning-issues",
  schedule: "0 9 * * 1-5",  // 工作日早 9 点
  task: "拉取昨日生产环境错误日志，归类异常原因，有高频问题直接给排查建议",
  userId: "tang",
});
```

