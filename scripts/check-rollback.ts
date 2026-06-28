/**
 * /rollback 菜单化后的核心语义离线校验:
 * 选中下标 picked(0-based)= 第 (picked+1) 轮 → planRollback(picked) 保 1..picked(删该轮及之后),
 * 预填 userTexts[picked](该轮 user 输入)。锁住 off-by-one(选中第 X 轮 = 删 X 轮及之后,不是 1..X)。
 * rollback 模块是纯逻辑(无 TTY),可直测。
 */
import process from 'node:process';
import {
  resetState,
  beginTurn,
  planRollback,
  applyRollback,
} from '../src/rollback/index.js';
import type { ChatMessage } from '../src/llm/index.js';

let pass = 0;
let fail = 0;
const log = (s: string): void => process.stdout.write(s + '\n');
const ok = (n: string, c: boolean): void => {
  if (c) {
    pass++;
    log(`✓ ${n}`);
  } else {
    fail++;
    log(`✗ ${n}`);
  }
};

function mk(role: 'system' | 'user' | 'assistant', content: string): ChatMessage {
  return { role, content } as ChatMessage;
}

// history: [sys, u1, a1, u2, a2, u3, a3] —— 3 轮
//   idx:    0    1   2   3   4   5   6
function freshHistory(): ChatMessage[] {
  return [
    mk('system', 'sys'),
    mk('user', 'u1'),
    mk('assistant', 'a1'),
    mk('user', 'u2'),
    mk('assistant', 'a2'),
    mk('user', 'u3'),
    mk('assistant', 'a3'),
  ];
}

resetState();
beginTurn('turn1'); // turnId 1
beginTurn('turn2'); // turnId 2
beginTurn('turn3'); // turnId 3

// userTexts 提取(镜像 rollbackFlow)
const userTexts = (h: ChatMessage[]): string[] =>
  h
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : ''));

// 1. picked=1(第 2 轮):保 1..1(只 turn1),删 turn2+,预填 u2
{
  const h = freshHistory();
  const ut = userTexts(h);
  const picked = 1;
  const prefillText = ut[picked] ?? '';
  const plan = planRollback(picked, h);
  ok('picked=1: cutoffIndex = user2 下标 3(保 [0,3)=turn1)', plan.cutoffIndex === 3);
  ok('picked=1: 预填 = u2(第 2 轮 user)', prefillText === 'u2');
  ok('picked=1: X = picked+1 = 2', picked + 1 === 2);
  const r = applyRollback(plan, h, new Set());
  ok('picked=1: applyRollback 截到 3 条(sys+u1+a1)', h.length === 3);
  ok('picked=1: 末条 = a1(turn1 回复)', h[2].content === 'a1');
  ok('picked=1: 删了 4 条(u2..a3)', r.deletedMsgs === 4);
}

// 2. picked=0(第 1 轮,从头跑):保 1..0(只 system),删 turn1+,预填 u1
{
  const h = freshHistory();
  const ut = userTexts(h);
  const picked = 0;
  const plan = planRollback(picked, h);
  ok('picked=0: cutoffIndex = user1 下标 1(保 [0,1)=只 sys)', plan.cutoffIndex === 1);
  ok('picked=0: 预填 = u1', (ut[picked] ?? '') === 'u1');
  const r = applyRollback(plan, h, new Set());
  ok('picked=0: 截到 1 条(只 sys)', h.length === 1);
  ok('picked=0: 删了 6 条', r.deletedMsgs === 6);
}

// 3. picked=2(第 3 轮,末轮):保 1..2(turn1+2),删 turn3+,预填 u3
{
  const h = freshHistory();
  const ut = userTexts(h);
  const picked = 2;
  const plan = planRollback(picked, h);
  ok('picked=2: cutoffIndex = user3 下标 5(保 [0,5)=turn1+2)', plan.cutoffIndex === 5);
  ok('picked=2: 预填 = u3', (ut[picked] ?? '') === 'u3');
  const r = applyRollback(plan, h, new Set());
  ok('picked=2: 截到 5 条', h.length === 5);
  ok('picked=2: 末条 = a2', h[4].content === 'a2');
  ok('picked=2: 删了 2 条(u3+a3)', r.deletedMsgs === 2);
}

// 4. planRollback 不改 history(只读规划;applyRollback 才原地截)
{
  const h = freshHistory();
  const len0 = h.length;
  planRollback(1, h);
  ok('planRollback 不改 history(只读)', h.length === len0);
}

log(`\n${fail === 0 ? 'OK' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
