// 内置 encoder 清单。仅由 opt-in pressure stage 首次调用时懒注册。
// Normal tool pushes do not pass through these encoders.
// Available transforms:tree / search / log / table / memory / code / doc / summary.
// status 类工具本就是短结果，无专用 encoder。

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
