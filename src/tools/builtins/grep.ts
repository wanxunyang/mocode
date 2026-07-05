import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import { MAX_RESULTS, IGNORE } from '../constants.js';
import { getSandboxRoot, isInsideRoot, jailResolve } from '../../sandbox/index.js';
import type { Tool } from '../types.js';

// ---------- grep ----------
export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents by regex (recursive, excludes node_modules/.git).\n' +
    'Output: per-file header "<path>: N matches, lines [l1, l2, ...]" + first N matching lines.\n' +
    'Use the line-number list to call read_file(offset=X, limit=Y) for each region — ' +
    'do NOT read entire files after grepping. Prefer codegraph for call chains.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression' },
      glob: { type: 'string', description: 'Optional, restrict to a file glob, e.g. *.ts' },
      max_per_file: {
        type: 'integer',
        description: 'Max body lines per file (default 15, cap 50). Line-number list is always full.',
      },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const pattern = String(args.pattern);
    const g = String(args.glob ?? '**/*');
    const maxPerFile = Math.min(Math.max(Number(args.max_per_file ?? 15), 1), 50);
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return `错误:非法正则 ${pattern}: ${e instanceof Error ? e.message : String(e)}`;
    }
    const cwd = getSandboxRoot() ?? process.cwd();
    const files = (
      await fg(g, {
        cwd,
        onlyFiles: true,
        dot: true,
        ignore: IGNORE,
        followSymbolicLinks: false, // 不跟随软链目录,防经软链扫到牢外文件
        throwErrorOnBrokenSymbolicLink: false,
      })
    ).filter((f) => isInsideRoot(f)); // 后置兜底:仅留牢内

    // 两段式输出:每个文件先收集全部命中行号,再决定哪些给 body 详情。
    // 关键点:行号列表(摘要)永远全给,body 配额用完即止 —— 这样 LLM 一眼看到
    // 「foo.ts 在 [12, 56, 134, 245] 命中」,可直接 read_file(offset=12, limit=60)。
    type FileHit = { path: string; lineNos: number[]; bodies: string[] };
    const hits: FileHit[] = [];
    let scanned = 0;
    let truncated = false;

    outer: for (const f of files) {
      let content: string;
      try {
        // jailResolve:realpath 化,防「牢内文件软链→牢外」的内容泄露;越界/不可读均 catch 跳过
        content = await readFile(jailResolve(f), 'utf8');
      } catch {
        continue; // 跳过无法读的文件(二进制/权限/沙箱越界)
      }
      scanned++;
      const lines = content.split(/\r?\n/);
      const lineNos: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) lineNos.push(i + 1);
      }
      if (lineNos.length === 0) continue;
      // 全局配额:行号列表总是计入,body 行数也计入(行号 + body 两条共用 MAX_RESULTS)
      const totalCost = lineNos.length + Math.min(lineNos.length, maxPerFile);
      if (hits.length >= MAX_RESULTS || totalCost > MAX_RESULTS * 4) {
        // 文件过多 / 配额爆:仅追加该文件行号列表,不再展开 body
        if (hits.length < MAX_RESULTS) {
          hits.push({ path: f, lineNos, bodies: [] });
        }
        truncated = true;
        continue;
      }
      const bodies = lineNos.slice(0, maxPerFile).map((n) => {
        const trimmed = lines[n - 1].trim();
        return `  L${n}: ${trimmed}`;
      });
      hits.push({ path: f, lineNos, bodies });
    }

    if (hits.length === 0) return `无匹配(扫描了 ${scanned} 个文件)`;

    const out: string[] = [];
    let totalShown = 0;
    for (const h of hits) {
      const header = `${h.path}: ${h.lineNos.length} 处匹配,行号 [${h.lineNos.join(', ')}]`;
      out.push(header);
      if (h.bodies.length > 0) {
        out.push(...h.bodies);
      } else {
        out.push(`  (body 已折叠,见上方行号列表 → read_file 精读)`);
      }
      totalShown += h.lineNos.length + h.bodies.length;
      if (totalShown >= MAX_RESULTS) {
        out.push(`...(结果达到 ${MAX_RESULTS} 条上限)`);
        break;
      }
    }
    if (truncated) out.push(`...(仍有更多匹配文件未展示,缩小 glob 或收窄正则)`);
    return out.join('\n');
  },
};
