import type { ContextEncoder } from '../types.js';

/**
 * File Tree Encoder(glob):扁平路径列表 → 按目录分组缩进树。
 *
 * 输入:glob 返回的路径(每行一条,\n 拼接),可能带尾部 `... (共 N 个,仅显示前 200)`。
 * 输出:目录头(以 `/` 结尾)+ 其下 2 空格缩进的文件,顶部 `# N files · tree-encoded` 计数。
 *
 * 不变量(离线脚本断言):路径条数与集合保真——每个原始路径可从树还原:
 *  目录头 `dir/` + 其下缩进行 `  file` → `dir/file`;根文件(无缩进、不以 `/` 结尾)→ 自身。
 * 小输入(≤1 路径,含 `无匹配文件` 单行)原样返回:tree 无收益且避免计数头开销。
 * 路径分隔符归一化(`\`→`/`):Windows 下 glob 可能返 `\`,树内统一 `/`。
 */
function normalizeSep(p: string): string {
  return p.replace(/\\/g, '/');
}

export const treeEncoder: ContextEncoder = {
  kind: 'tree',
  encode({ output }) {
    const lines = output.split('\n');
    // 分离路径与尾部标记(glob 的 `... (共 N 个...)`)。首个非路径行起全部视作 tail 原样保留。
    const paths: string[] = [];
    const tail: string[] = [];
    let inTail = false;
    for (const l of lines) {
      if (!l) continue;
      if (!inTail && (l.startsWith('...') || /^\(共/.test(l))) {
        inTail = true;
      }
      if (inTail) tail.push(l);
      else paths.push(l);
    }
    if (paths.length <= 1) {
      // ≤1 路径:tree 无收益(含 `无匹配文件`),原样返回。
      return {
        text: output,
        meta: {
          kind: 'tree',
          originalLen: output.length,
          encodedLen: output.length,
          note: '≤1 path → passthrough',
        },
      };
    }
    // 按目录分组(保留首次出现顺序,保还原后顺序与原一致)
    const groups = new Map<string, string[]>();
    const order: string[] = [];
    for (const p of paths) {
      const norm = normalizeSep(p);
      const idx = norm.lastIndexOf('/');
      const dir = idx >= 0 ? norm.slice(0, idx + 1) : ''; // 含尾斜杠
      const file = idx >= 0 ? norm.slice(idx + 1) : norm;
      if (!groups.has(dir)) {
        groups.set(dir, []);
        order.push(dir);
      }
      groups.get(dir)!.push(file);
    }
    const out: string[] = [`# ${paths.length} files · tree-encoded`];
    for (const dir of order) {
      const files = groups.get(dir)!;
      if (dir === '') {
        for (const f of files) out.push(f);
      } else {
        out.push(dir);
        for (const f of files) out.push(`  ${f}`);
      }
    }
    if (tail.length) out.push(...tail);
    const text = out.join('\n');
    return {
      text,
      meta: {
        kind: 'tree',
        originalLen: output.length,
        encodedLen: text.length,
        note: `${paths.length} files / ${order.length} dirs`,
      },
    };
  },
};
