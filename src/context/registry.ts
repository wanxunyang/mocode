// kind → encoder 注册表。单一事实源(仿 tools/registry.ts 的 tools[] 风格)。
//
// 内置 encoder 在 encoders/index.ts 的 builtinEncoders 数组声明,启动期 pipeline 首次调用时
// 经 registerAll 注册(懒注册,避免循环 import 在模块加载期触发)。
// MCP 工具(未来)可在并入 tools/registry.ts 时调 registerEncoder 注册私有 encoder(后注册覆盖默认)。
//
// 未注册的 kind → getEncoder 返 undefined → pipeline 回落 passthrough(identity),零行为变化。

import type { ContextEncoder, ContextKind } from './types.js';

const encoders = new Map<ContextKind, ContextEncoder>();
let registered = false;

/** 注册一个 encoder(后注册覆盖先注册,允许 MCP 覆盖默认)。返回 encoder 自身供链式。 */
export function registerEncoder(enc: ContextEncoder): ContextEncoder {
  encoders.set(enc.kind, enc);
  return enc;
}

/** 批量注册(启动期 pipeline 调一次)。幂等:重复调忽略。 */
export function registerAll(list: ContextEncoder[]): void {
  if (registered) return;
  for (const e of list) registerEncoder(e);
  registered = true;
}

/** 取某 kind 的 encoder;未注册返 undefined(pipeline 回落 passthrough)。 */
export function getEncoder(kind: ContextKind): ContextEncoder | undefined {
  return encoders.get(kind);
}

/** 调试:列出已注册 kind。 */
export function registeredKinds(): ContextKind[] {
  return [...encoders.keys()];
}
