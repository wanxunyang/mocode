// 沙箱策略分类集 + 集中执行 enforceSandbox。单一事实源,仿 tools/constants.ts 的
// PLAN_DISABLED_TOOLS / READ_TOOL_NAMES 风格。
import { jailResolve, jailGlobPattern } from './jail.js';

/**
 * 豁免 cwd 牢笼的工具:
 *  - memory_*:操作 ~/.mocode 与 <cwd>/.mocode,本就该在外圈
 *  - use_skill:读 ~/.claude/skills、~/.mocode/skills、<cwd>/.mocode/skills,部分在外圈
 *  - web_*:跨网络,非文件路径
 *  - ask_human / switch_mode:无文件路径
 *  - codegraph:只读 cwd 下 .codegraph/ 索引(只读、不写盘)
 *  - task:派生子 agent,继承全局 root(子 agent 同进程天然共享 getSandboxRoot)
 */
export const SANDBOX_EXEMPT_TOOLS = new Set([
  'memory_save', 'memory_update', 'memory_forget', 'memory_search', 'memory_list',
  'use_skill',
  'web_search', 'web_fetch',
  'ask_human', 'switch_mode',
  'codegraph',
  'task',
  'todolist', // 写 .mocode/plans/<id>.md(id 服务端生成,无路径注入);操作项目内元数据
]);

/**
 * 路径类工具:enforceSandbox 集中把 args.path 重写为牢内绝对路径(默认安全;工具内
 * resolve(absolutePath) 原样返回)。**新加带 path 参数的工具须列入此集**,否则不会被牢笼挡。
 */
export const SANDBOX_PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);

/**
 * 工具执行前的沙箱校验。返 string = 拒绝(直接喂 LLM,不执行);返 null = 放行(可能已重写 args.path)。
 * **不抛**——契约对齐「调度器永不抛错、永远返回字符串」(tools/registry.ts executeTool)。
 * run_command 不在此处理(cwd / env / denylist 在其站点)。
 */
export function enforceSandbox(
  name: string,
  args: Record<string, unknown>,
): string | null {
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
