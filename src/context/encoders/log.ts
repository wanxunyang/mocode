import type { ContextEncoder } from '../types.js';

/**
 * Log Encoder(run_command):去 ANSI 颜色码 + 折叠连续重复行(≥3 → 单行 + [×N])。
 *
 * 输入:run_command 返回的 `[退出码 N]\n<合并 stdout+stderr>`,可能含 ANSI(tsc --pretty / 测试框架)、
 *  重复行(构建 / 编译日志)、尾部 `...(输出已截断)`、`[已中断]` / `[超时,已终止]` 前缀。
 * 输出:去 ANSI CSI 序列 + 连续重复行折叠;行顺序不变(退出码头恒在首、错误行与尾部原位保留)。
 *
 * 不变量(离线脚本断言):退出码行 `[退出码 N]` / `[已中断]` / `[超时,已终止]` 保留;
 *  重复行以 `[×N]` 标注计数(语义不丢——LLM 仍知该行重复 N 次);ANSI 去除语义无损(颜色码不含信息)。
 * 不做长度裁剪(由 pipeline 末尾 capToolResultForHistory 兜底 head+标记+tail,与改造前一致)。
 * run ≤2 原样保留(常见输出不必标注,避免噪音);run ≥3 才折叠(真正的大规模重复才省)。
 */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export const logEncoder: ContextEncoder = {
  kind: 'log',
  encode({ output }) {
    // 去 ANSI CSI 序列(颜色 / 光标 / 清屏等),保留所有可见文本。
    const stripped = output.replace(ANSI_RE, '');
    const lines = stripped.split('\n');
    // 折叠连续重复行:run ≥3 → 单行 + [×N];run ≤2 原样。
    const out: string[] = [];
    let i = 0;
    let collapsedRuns = 0;
    while (i < lines.length) {
      let j = i;
      while (j < lines.length && lines[j] === lines[i]) j++;
      const run = j - i;
      if (run >= 3) {
        out.push(`${lines[i]}  [×${run}]`);
        collapsedRuns++;
      } else {
        for (let k = 0; k < run; k++) out.push(lines[i]);
      }
      i = j;
    }
    const text = out.join('\n');
    return {
      text,
      meta: {
        kind: 'log',
        originalLen: output.length,
        encodedLen: text.length,
        note:
          collapsedRuns > 0
            ? `ANSI stripped, ${collapsedRuns} dup runs collapsed`
            : 'ANSI stripped',
      },
    };
  },
};
