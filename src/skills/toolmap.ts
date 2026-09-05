// skill 工具名映射(叶子模块,零依赖,避免激活态/runner 与 tools/constants 之间的循环依赖)。
// 把 Agent Skills 开放标准里的工具 token 归一为 mocode 工具名。
//
// 关键约束:只做「名字翻译」,绝不把 `Bash(git:*)` 的括号内容当作命令白名单——
// mocode 的权限是 run_command 粒度(permissions/index.ts 的 permissionFingerprint),
// 不解析 shell 前缀。`Bash(git:*)` 在 mocode 里等同于「允许子 agent 用 run_command」,
// 具体命令仍走 denylist + 沙箱。

/** 标准 token(大小写不敏感)→ mocode 工具名。带括号的 `Bash(...)` 也按 Bash 前缀归并。
 * 同时接受 mocode 原生工具名(write_file / web_fetch…),即标准名与原生名两种写法。 */
const TOKEN_MAP: Array<{ re: RegExp; tool: string }> = [
  { re: /^read(_file)?$/i, tool: 'read_file' },
  { re: /^grep$/i, tool: 'grep' },
  { re: /^glob$/i, tool: 'glob' },
  { re: /^bash$/i, tool: 'run_command' }, // Bash(...) 也落到 run_command
  { re: /^run_command$/i, tool: 'run_command' },
  { re: /^write(_file)?$/i, tool: 'write_file' },
  { re: /^edit(_file)?$/i, tool: 'edit_file' },
  { re: /^web_?search$/i, tool: 'web_search' },
  { re: /^web_?fetch$/i, tool: 'web_fetch' },
  { re: /^use_skill$/i, tool: 'use_skill' },
  { re: /^run_skill$/i, tool: 'run_skill' },
  { re: /^memory_search$/i, tool: 'memory_search' },
  { re: /^memory_list$/i, tool: 'memory_list' },
];

/** 把单个标准 token 映射成 mocode 工具名;未知 token 返 null(调用方记 warning + 忽略)。 */
export function mapSkillToolName(token: string): string | null {
  const t = token.trim();
  if (!t) return null;
  // 去掉可能的括号后缀(Bash(git:*) → Bash)
  const base = t.replace(/\(.*\)$/, '').trim();
  for (const { re, tool } of TOKEN_MAP) {
    if (re.test(base)) return tool;
  }
  return null;
}

/** 把 allowed-tools / disallowed-tools 的 token 列表映射为 mocode 工具名集合;
 * 未知 token 收集到 unknown 返回,供调用方记 warning。返回 null 表示未声明(不约束)。 */
export function mapSkillTools(tokens: string[] | undefined): { tools: string[] | null; unknown: string[] } {
  if (tokens === undefined) return { tools: null, unknown: [] };
  if (tokens.length === 0) return { tools: [], unknown: [] };
  const tools: string[] = [];
  const unknown: string[] = [];
  for (const tk of tokens) {
    const mapped = mapSkillToolName(tk);
    if (mapped) {
      if (!tools.includes(mapped)) tools.push(mapped);
    } else {
      unknown.push(tk);
    }
  }
  // 显式声明但全是未知 token 时保持零工具，绝不回退成 unrestricted。
  return { tools, unknown };
}
