/**
 * work-app 渲染层的 markdown 解析器：**死循环回归**。
 *
 * 为什么这条测试要用子进程 + 超时，而不是直接断言返回值：
 *
 * 这个 bug 的形态是 `renderMarkdown('# ')` 永不返回 —— 主线程彻底卡死。真在测试进程里
 * 直接调它，一旦回归就是整个 `node --test` 被这一条吊住、其余测试全被取消
 * （表现是满屏 cancelledByParent，而汇总仍写着 `# fail 0`）。那种失败现场比 bug 本身还难读，
 * 所以这里把渲染放进子进程：卡死 → SIGTERM → 一条清晰的失败断言。
 *
 * 真实触发路径（不是构造出来的边界）：流式渲染逐字符到达，`## 打包` 必经 `## ` 这一帧，
 * 那一刻缓冲区最后一行恰好是「井号 + 空格」。用户看到的就是整窗冻结、连「正在回复 2s」
 * 都不再跳动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 编译后的渲染器路径（dist-tests 下与源码同构）。 */
const RENDERER = fileURLToPath(new URL('../../packages/work-app/src/renderer/markdown.js', import.meta.url));

/** 在子进程里渲染一次；超时即判定死循环。 */
function renderInChild(text: string, cols = 80): { hung: boolean; html: string; stderr: string } {
  const script = `const m = await import(${JSON.stringify(`file:///${RENDERER.replaceAll('\\', '/')}`)});
process.stdout.write(m.renderMarkdown(process.env.TEXT, Number(process.env.COLS)));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TEXT: text, COLS: String(cols) },
    timeout: 5_000,
    encoding: 'utf8',
  });
  return { hung: result.status !== 0, html: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('流式半截语法不得卡死：井号 + 空白必须当成普通段落', () => {
  // 每一个都是流式途中真实会出现的缓冲末尾。此前 `# ` 类全部死循环（`- ` / `1. ` / `> `
  // 因为有各自的分支接住，不受影响 —— 这解释了为什么只有标题会冻界面）。
  const prefixes = ['# ', '## ', '### ', '###### ', '#\t', '#\u00a0', '#  '];
  for (const prefix of prefixes) {
    const { hung, stderr } = renderInChild(prefix);
    assert.equal(hung, false, `渲染 ${JSON.stringify(prefix)} 卡死（死循环）：${stderr.slice(0, 200)}`);
  }
});

test('半截语法出现在其它结构之后也不得卡死', () => {
  const cases = ['text\n# ', 'a\n\n## ', '```\n# ', '- a\n# ', '> q\n# ', '| a | b |\n|---|---|\n| 1 | 2 |\n# '];
  for (const text of cases) {
    const { hung, stderr } = renderInChild(text);
    assert.equal(hung, false, `渲染 ${JSON.stringify(text)} 卡死：${stderr.slice(0, 200)}`);
  }
});

test('逐字符前缀全量扫描：任何一帧都不得卡死', () => {
  // 流式渲染每一帧都会把「当前累积文本」整段重渲一遍。这里覆盖标题/代码块/表格/列表/引用，
  // 每一个前缀都必须能返回 —— 任一帧卡住，界面上就是永久冻结。
  const doc = [
    '## 打包',
    '',
    '```',
    'packages/work-app/release/MoCode Work-1.1.0-setup.exe   146MB',
    '```',
    '',
    '`verify-pack.mjs` 七项全过。',
    '',
    '| 检查 | 结果 |',
    '|---|---|',
    '| 根 `npm test` | 1594 pass |',
    '',
    '### 三级标题',
    '',
    '1. 有序列表',
    '- 无序列表',
    '> 引用',
  ].join('\n');
  for (let n = 1; n <= doc.length; n += 7) {
    const { hung, stderr } = renderInChild(doc.slice(0, n));
    assert.equal(
      hung,
      false,
      `前缀 ${n} 卡死（尾部 ${JSON.stringify(doc.slice(Math.max(0, n - 12), n))}）：${stderr.slice(0, 200)}`,
    );
  }
});

test('正常 markdown 仍然渲染成对应结构', () => {
  const { hung, html } = renderInChild('## 标题\n\n- 一项\n- 两项\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(hung, false);
  assert.match(html, /<h2>标题<\/h2>/);
  assert.match(html, /<ul><li>一项<\/li><li>两项<\/li><\/ul>/);
  assert.match(html, /<table>/);
});
