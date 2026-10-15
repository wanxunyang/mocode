#!/usr/bin/env node
// mocode 全局入口:shebang + 拉起编译产物。子命令(--resume / config)路由在 dist/index.js 的 main() 内,
// 用动态 import 按需加载,避免 `mocode config`(零配置时)触发 config/index.ts 的 requireEnv 退出。

// Node 编译缓存:把模块字节码缓存到 ~/.mocode/compile-cache,大幅缩短冷态(开机首跑)启动——
// 磁盘缓存冷时 openai 等大依赖的逐文件编译是首帧最大瓶颈。enableCompileCache 需 Node ≥22.8;
// 低版本无此 API,跳过(engines 仍为 >=18,不阻塞安装)。缓存目录不可写时 Node 只打 warning 不失败。
try {
  const { enableCompileCache } = await import('node:module');
  if (typeof enableCompileCache === 'function') {
    const os = await import('node:os');
    const path = await import('node:path');
    enableCompileCache(path.join(os.homedir(), '.mocode', 'compile-cache'));
  }
} catch {
  // 旧 Node / 缓存目录异常:退回无缓存路径,行为不变。
}

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
