#!/usr/bin/env node
// mocode 全局入口:shebang + 拉起编译产物。子命令(--resume / config)路由在 dist/index.js 的 main() 内,
// 用动态 import 按需加载,避免 `mocode config`(零配置时)触发 config/index.ts 的 requireEnv 退出。
await import('../dist/index.js');
