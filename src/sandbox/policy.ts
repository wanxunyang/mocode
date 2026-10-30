// 沙箱策略分类集 + 集中执行 enforceSandbox。单一事实源,仿 tools/constants.ts 的
// PLAN_DISABLED_TOOLS / READ_TOOL_NAMES 风格。
import { jailResolve, jailGlobPattern } from './jail.js';

/**
 * 豁免 cwd 牢笼的工具:
 *  - memory_*:操作 ~/.mocode 与 <cwd>/.mocode,本就该在外圈
 *  - use_skill:读 ~/.claude/skills、~/.mocode/skills、<cwd>/.mocode/skills,部分在外圈
 *  - web_*:跨网络,非文件路径
 *  - ask_human:无文件路径
 *  - sub-agent:派生子 agent，通过 scoped sandbox root 使用隔离 overlay
 *
 *  注:codegraph 不再是核心工具,已 skill 化(用 run_command 调 CLI),
 * 不在此处登记。switch_mode 工具已砍,模式切换仅由 repl 的 /plan / /auto /
 * Shift+Tab 等用户面触发,不经工具路径。
 */
export const SANDBOX_EXEMPT_TOOLS = new Set([
  'memory_save',
  'memory_update',
  'memory_forget',
  'memory_search',
  'memory_list',
  'memory_graph',
  'use_skill',
  'web_search',
  'web_fetch',
  'ask_human',
  'sub-agent',
]);

/**
 * 路径类工具:enforceSandbox 集中把 args.path 重写为牢内绝对路径(默认安全;工具内
 * resolve(absolutePath) 原样返回)。**新加带 path 参数的工具须列入此集**,否则不会被牢笼挡。
 */
export const SANDBOX_PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);

/**
 * 记忆子系统的**持久状态文件**(R16.5)。
 *
 * 为什么需要这份名单:`SANDBOX_PATH_TOOLS` 只把路径栏在 cwd 内,而 `<cwd>/.mocode/`
 * 恰恰就在 cwd 里。于是 `write_file('.mocode/memory.jsonl', …)` 完全合法——模型(或一次
 * 被注入的指令)可以直接覆盖整个记忆库、往图谱里塞一条伪造的 `person-primary --works_at-->`
 * 边,或把 pending 队列清空。记忆是**跨会话长期生效**的状态,一旦被写脏,影响面远超一次错误编辑。
 *
 * 为什么拦在沙箱层而不是在 memory_* 工具里:模型手上能碰文件的工具是 write_file/edit_file,
 * 它们与 memory_* 毫无关联。拦在 memory_* 内部等于没拦。
 *
 * 为什么**不**拦读取:`memory_search` 之外,诊断与自查常要读这几个文件。禁读只会把
 * 可观测性一起关掉,而读不会污染状态。
 */
const MEMORY_STATE_FILES = [
  'memory.jsonl', // 条目库(两 scope:global + project)
  'memory-graph.json', // 知识图谱
  'memory-pending.jsonl', // 压缩→反思候选队列
  'memory-audit.jsonl', // R8 审计日志
  'memory-health.json', // 健康快照
  'memory-recall-stats.json', // 召回统计(R0.2)
];

/**
 * 写入类工具试图改 `.mocode` 下的记忆状态文件时返回拒绝文案;否则 null。
 *
 * 判定按**路径分量**而不是字符串包含:必须同时满足 ①父目录段恰为 `.mocode`,
 * ②文件名在名单内(允许 `.tmp` 后缀——原子写的半成品同样不能碰)。
 * 这样 `src/.mocode-spec/memory.jsonl`(不在 .mocode 目录下)不会被误伤。
 */
function rejectMemoryStateWrite(absPath: string): string | null {
  const parts = absPath.split(/[\\/]+/).filter(Boolean);
  const base = (parts.at(-1) ?? '').toLowerCase();
  const dir = (parts.at(-2) ?? '').toLowerCase();
  if (dir !== '.mocode') return null;
  const name = base.endsWith('.tmp') ? base.slice(0, -4) : base;
  if (!MEMORY_STATE_FILES.includes(name)) return null;
  return (
    `错误:${name} 是记忆子系统的持久状态文件,不允许用写文件工具直接改动。` +
    `请改用 memory_save / memory_update / memory_forget / memory_graph 工具,` +
    `或 /memory 命令(批量遗忘、导出、暂停)。`
  );
}

/**
 * 工具执行前的沙箱校验。返 string = 拒绝(直接喂 LLM,不执行);返 null = 放行(可能已重写 args.path)。
 * **不抛**——契约对齐「调度器永不抛错、永远返回字符串」(tools/registry.ts executeTool)。
 * run_command 不在此处理(cwd / env / denylist 在其站点)。
 */
export function enforceSandbox(name: string, args: Record<string, unknown>): string | null {
  if (SANDBOX_EXEMPT_TOOLS.has(name)) return null;

  if (SANDBOX_PATH_TOOLS.has(name)) {
    const p = args.path;
    if (typeof p === 'string' && p) {
      try {
        args.path = jailResolve(p);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return `错误:路径越界,已被沙箱拒绝: ${p} (${why})`;
      }
      // 校验在重写之后:判的是**真实目标**而不是模型写的相对串,
      // 否则 `./.mocode/../.mocode/memory.jsonl` 这类变体可以绕过。
      if (name !== 'read_file') {
        const deny = rejectMemoryStateWrite(args.path as string);
        if (deny) return deny;
      }
    }
    return null;
  }

  if (name === 'glob') {
    const pat = String(args.pattern ?? '');
    const err = jailGlobPattern(pat);
    return err ? `错误:glob ${err}` : null;
  }
  if (name === 'grep') {
    const pat = String(args.glob ?? '**/*');
    const err = jailGlobPattern(pat);
    return err ? `错误:grep glob ${err}` : null;
  }

  return null;
}
