import type { ContextEncoder } from '../types.js';

/**
 * 兜底 encoder:identity,原样返回。
 *  - classifier 未命中任何 kind(返回 'passthrough')时用。
 *  - pipeline 总开关关闭(MOCODE_CONTEXT_OPTIMIZE=false)时,所有 kind 都走它 → 行为与改造前逐字节一致。
 *  - Phase 1 阶段 registry 只注册它 → 全链路零行为变化。
 *  - 任何 encoder 报错时,pipeline catch 后回落到它(传原 output)。
 *
 * 永不抛错:output 可能是任意字符串(含 ANSI / 多行 / 非法 UTF-8 片段),identity 直接返回,无解析风险。
 */
export const passthroughEncoder: ContextEncoder = {
  kind: 'passthrough',
  encode({ output }) {
    return {
      text: output,
      meta: {
        kind: 'passthrough',
        originalLen: output.length,
        encodedLen: output.length,
        note: 'identity (no encoder registered)',
      },
    };
  },
};
