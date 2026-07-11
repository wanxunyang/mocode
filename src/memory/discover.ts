// memory 发现子系统:加载项目记忆 MOCODE.md(对标 skills/discover.ts 的叶子模式)。
// 仅依赖 node 标准库,是叶子模块:不依赖 config/agent/llm/tools/skills,避免环。
//
// 约定:纯 MOCODE.md(mocode 是独立工具,有自己的工具集与约定)。
// 项目级从 cwd 向上逐级找,全局 ~/.mocode/MOCODE.md。全量注入 systemPrompt(超长截断);

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface MemoryFile {
  path: string;
  content: string;
}

/**
 * 返回要查找的 MOCODE.md 路径列表,按「远→近」顺序(合并时近的在后,更突出):
 * 全局 ~/.mocode/MOCODE.md → 项目级从根到 cwd 逐级 MOCODE.md。
 * 向上遍历 cwd 到根收集 [cwd..root],反转为 [root..cwd](远→近),前拼全局。
 */
export function resolveMemoryFiles(): string[] {
  const globalPath = path.join(os.homedir(), '.mocode', 'MOCODE.md');
  const projectFiles: string[] = [];
  let dir = process.cwd();
  const root = path.parse(dir).root; // win32 'C:\\', POSIX '/'
  for (;;) {
    projectFiles.push(path.join(dir, 'MOCODE.md'));
    if (dir === root || dir === path.dirname(dir)) break; // 到根:dirname 自身
    dir = path.dirname(dir);
  }
  projectFiles.reverse(); // root..cwd(远→近)
  return [globalPath, ...projectFiles];
}

/**
 * 读取所有存在的 MOCODE.md,返回 { path, content }(content 已 trim)。
 * 全程静默容错(不存在 / 读失败 → 跳过,不抛),风格对齐 skills/discover.ts 与 session/persist.ts。
 */
export function loadMemoryFiles(): MemoryFile[] {
  const files = resolveMemoryFiles();
  const out: MemoryFile[] = [];
  for (const p of files) {
    try {
      if (!existsSync(p)) continue;
      const content = readFileSync(p, 'utf8').trim();
      if (content) out.push({ path: p, content });
    } catch {
      continue; // 读失败静默跳过
    }
  }
  return out;
}
