import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ansiDisplayWidth } from '../src/ui/render.js';
import { renderWelcomeRows } from '../src/ui/layout-internal/content-write.js';

const RESET = '\x1B[0m';

// 欢迎块 resize 重排的纯渲染部分:renderWelcomeRows 把逻辑行(带色、不带缩进)按
// 可见宽度居中。layout 侧的删块重写编排依赖 TTY(contentWrite 物理写),不在单测覆盖面。
describe('welcome block rows rendering', () => {
  it('按可见宽度整行居中(ANSI 不计宽、CJK 计 2、余数归右)', () => {
    const line = `\x1B[2m直接输入消息${RESET}`; // 可见宽度 = 6 * 2 = 12
    const [row] = renderWelcomeRows([line], 31);
    const pad = Math.floor((31 - 12) / 2);
    assert.equal(row, `${' '.repeat(pad)}${line}`);
    assert.equal(ansiDisplayWidth(row), pad + 12);
  });

  it('空行原样输出,不补缩进', () => {
    assert.deepEqual(renderWelcomeRows([''], 40), ['']);
  });

  it('可见宽度 ≥ cols 的行不缩进(折行由 contentWrite 兜底)', () => {
    const wide = 'a'.repeat(40);
    assert.deepEqual(renderWelcomeRows([wide], 40), [wide]);
    assert.deepEqual(renderWelcomeRows([wide], 10), [wide]);
  });

  it('同一逻辑行源在不同列宽下重新居中(resize 前后 pad 随宽度变化)', () => {
    const line = `\x1B[1m\x1B[33m在电脑原生终端运行 mocode${RESET}`; // 9 CJK*2 + 1 + 6 = 25
    const w = ansiDisplayWidth(line);
    assert.equal(w, 25);
    assert.equal(renderWelcomeRows([line], 30)[0], `${' '.repeat(Math.floor((30 - w) / 2))}${line}`);
    assert.equal(renderWelcomeRows([line], 80)[0], `${' '.repeat(Math.floor((80 - w) / 2))}${line}`);
  });
});
