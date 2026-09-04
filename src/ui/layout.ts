// 桶文件:保持对外 import 路径不变(from '../ui/layout.js')
// 实际实现已移到 ui/layout-internal/core.ts,类型定义在 ui/layout-types.ts
export * from './layout-internal/core.js';
export type { Geo, StatusBarData, InputView } from './layout-types.js';
