/**
 * 底栏 plan chip 的 notes.md 解析单测(readPlanStatusFromNotes)。
 *
 * 背景:点击输入框上方的 plan 行可展开整个计划,UI 需要每一步的编号 / 短标签 /
 * 完成态 / 是否当前步,而不只是一条「(N/M) ▸ 当前步」摘要。本文件锁定解析契约:
 *   - 步骤按文件顺序逐条提取,total 与编号正确;
 *   - 第一个未完成步标记为 current(与摘要的 activeNo 自洽);
 *   - [x] 为 done,in_progress 行尾的 `◀ activeForm` 不污染短标签;
 *   - 只统计活跃 `## Plan:` 段,`## Done:` / 其它段的 checkbox 不计数;
 *   - 无活跃 plan 返 null。
 *
 * 注意:测试进程共享(--experimental-test-isolation=none),setSandboxRoot /
 * setCurrentSessionId 是全局单例——不用顶层 beforeEach/afterEach(钩子会与
 * sandbox.test.ts 等文件交错),改为每个用例内部同步 set + finally restore。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSandboxRoot } from '../src/sandbox/root.js';
import { setCurrentSessionId } from '../src/session/state.js';
import { planStepParts, renderPlanSection, type PlanState } from '../src/session/notes.js';
import { readPlanStatusFromNotes } from '../src/repl/status-bar.js';

const SESSION_ID = 'test-plan-parse';

/** 同步搭好临时沙箱 + session,跑断言,finally 恢复全局单例并清目录。 */
function withNotes(content: string, fn: () => void): void {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-plan-parse-'));
  const prevRoot = setSandboxRoot(tmpRoot);
  setCurrentSessionId(SESSION_ID, tmpRoot);
  try {
    const p = path.join(tmpRoot, '.mocode', 'sessions', SESSION_ID, 'notes.md');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
    fn();
  } finally {
    setSandboxRoot(prevRoot);
    setCurrentSessionId(undefined, tmpRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

test('解析全部步骤:编号 / done / current / 短标签', () => {
  const plan: PlanState = {
    title: '实现 §12',
    steps: [
      { title: '浏览面路由', content: '加 history 路由', status: 'completed' },
      { title: '社区市场', content: '独立服务方案', status: 'in_progress', activeForm: '设计服务边界' },
      { title: '联调', content: '端到端验证', status: 'pending' },
    ],
  };
  withNotes(`${renderPlanSection(plan)}\n`, () => {
    const got = readPlanStatusFromNotes();
    assert.ok(got);
    assert.equal(got.title, '实现 §12');
    assert.deepEqual(
      got.steps.map((s) => [s.no, s.label, s.done, s.current]),
      [
        [1, '浏览面路由', true, false],
        [2, '社区市场', false, true],
        [3, '联调', false, false],
      ],
    );
    // 摘要与展开数据自洽:当前是第 2 步,共 3 步。
    assert.equal(got.summary, 'plan: 实现 §12 (2/3) ▸ 社区市场');
  });
});

test('无 title 的老 plan:短标签回退为 content,activeForm 优先', () => {
  withNotes(
    ['## Plan: 老计划', '', '### Steps', '- [x] 1. 第一步详细描述', '- [ ] 2. 第二步详细描述  ◀ 进行中'].join('\n') +
      '\n',
    () => {
      const got = readPlanStatusFromNotes();
      assert.ok(got);
      assert.equal(got.steps.length, 2);
      assert.equal(got.steps[0]?.label, '第一步详细描述');
      assert.equal(got.steps[0]?.done, true);
      assert.equal(got.steps[1]?.current, true);
      assert.equal(got.steps[1]?.label, '进行中'); // activeForm 优先于裸 content
    },
  );
});

test('## Done: 段不产生活跃 plan(返回 null)', () => {
  withNotes('## Done: 已完成的旧活\n\n- [x] 1. 老步骤\n', () => {
    assert.equal(readPlanStatusFromNotes(), null);
  });
});

test('其它笔记段的 checkbox 不污染步骤列表', () => {
  const plan: PlanState = {
    title: 'p',
    steps: [{ title: 's1', content: 'c1', status: 'pending' }],
  };
  withNotes(`${renderPlanSection(plan)}\n\n## Findings\n- [ ] 一条带 checkbox 的发现\n`, () => {
    const got = readPlanStatusFromNotes();
    assert.ok(got);
    assert.equal(got.steps.length, 1);
    assert.equal(got.steps[0]?.no, 1);
  });
});

test('步骤详情:新格式拆出 label+detail,老格式 detail 为空', () => {
  // 新格式:`**短标题** — 详细描述`,详情可点击展开
  const plan: PlanState = {
    title: 'p',
    steps: [
      { title: '短标题', content: '这里是详细描述,比较长', status: 'pending' },
      { title: '无描述', content: '', status: 'pending' },
    ],
  };
  withNotes(`${renderPlanSection(plan)}\n`, () => {
    const got = readPlanStatusFromNotes();
    assert.ok(got);
    assert.equal(got.steps[0]?.detail, '这里是详细描述,比较长');
    assert.equal(got.steps[0]?.label, '短标题');
    // 无 content 的步骤:detail 缺省(点击无反应)
    assert.equal(got.steps[1]?.detail, undefined);
  });
  // 老格式(无 title):activeForm 优先当 label(与 planStepLabel 语义一致),detail 为空不可展开
  const parts = planStepParts('详细描述整行  ◀ 进行中');
  assert.equal(parts.label, '进行中');
  assert.equal(parts.detail, '');
  assert.equal(parts.activeForm, '进行中');
});
