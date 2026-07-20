#!/usr/bin/env node
// mocode 全局入口:shebang + 拉起编译产物。子命令(--resume / config)路由在 dist/index.js 的 main() 内,
// 用动态 import 按需加载,避免 `mocode config`(零配置时)触发 config/index.ts 的 requireEnv 退出。

// 抑制 openai v4 -> node-fetch v2 -> whatwg-url v5 链触发的 Node 内置 punycode 弃用警告,
// 防止 [DEP0040] 输出污染终端 UI 的输入框区域。
const originalEmit = process.emit;
process.emit = function (event, warning, ...args) {
  if (
    event === 'warning' &&
    warning &&
    warning.code === 'DEP0040' &&
    typeof warning.message === 'string' &&
    warning.message.includes('punycode')
  ) {
    return true;
  }
  return originalEmit.apply(this, [event, warning, ...args]);
};

await import('../dist/index.js');
