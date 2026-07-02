// 内置 encoder 清单。启动期 pipeline 首次调用时经 registerAll 注册到 registry。
//
// Phase 1:仅 passthrough(identity)→ 全链路零行为变化(所有 kind 都回落到它)。
// Phase 2 起逐步加入:tree / search / log / code / table / memory(见各 encoder 文件)。
//
// 加 encoder:新建 encoders/xxx.ts 导出 ContextEncoder,在此数组加一行。无需动 agent / llm / core。

import type { ContextEncoder } from '../types.js';
import { passthroughEncoder } from './passthrough.js';

export const builtinEncoders: ContextEncoder[] = [
  passthroughEncoder,
];
