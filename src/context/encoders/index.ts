// 内置 encoder 清单。启动期 pipeline 首次调用时经 registerAll 注册到 registry。
//
// Phase 1:passthrough(identity 兜底)→ 全链路零行为变化。
// Phase 2:tree / search / log / table / memory(高价值低风险)。
// Phase 2.5:code / graph / doc / summary(覆盖剩余有 encoder 的 kind)。
//   - code(read_file):仅折叠 ≥3 连续空行,行号保真(edit_file 依赖)。
//   - graph(保留 kind,暂无 builtin 工具直接命中)/ doc(web_fetch, use_skill)/ summary(task):
//     去 ANSI + 折叠空行,保守不重构结构。
//   - status(edit/write/ask_human/mem 增删改)无 encoder:本就是一行,无需编码。
//
// 加 encoder:新建 encoders/xxx.ts 导出 ContextEncoder,在此数组加一行。无需动 agent / llm / core。

import type { ContextEncoder } from '../types.js';
import { passthroughEncoder } from './passthrough.js';
import { treeEncoder } from './tree.js';
import { searchEncoder } from './search.js';
import { commandEncoder } from './command.js';
import { tableEncoder } from './table.js';
import { memoryEncoder } from './memory.js';
import { codeEncoder } from './code.js';
import { docEncoder } from './doc.js';
import { summaryEncoder } from './summary.js';

export const builtinEncoders: ContextEncoder[] = [
  passthroughEncoder,
  treeEncoder,
  searchEncoder,
  commandEncoder,
  tableEncoder,
  memoryEncoder,
  codeEncoder,
  docEncoder,
  summaryEncoder,
];
