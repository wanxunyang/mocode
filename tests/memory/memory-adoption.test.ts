/**
 * R19 记忆采纳观测闭环。
 *
 * 账本仅记录“送达/抑制/既有调用的评估”，不参与记忆检索、排序或条目写入。
 * 这里把可丢失/被伪造的边界钉住，避免健康指标把“模型没评估”误读成“未采纳”。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetAdoptionForTests,
  adoptionEvaluationInstruction,
  adoptionEvents,
  adoptionStats,
  applyAdoptionEvaluations,
  extractAdoptionEvaluations,
  flushAdoptionSuppressions,
  pendingAdoptionDeliveries,
  pruneAdoptionLedger,
  recordMemoryDelivery,
  recordMemorySuppression,
} from '../../src/memory/adoption.js';
import { setMemoryWritesPaused, __resetMemoryPauseForTests } from '../../src/memory/write-gate.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-adoption-'));
    const cwd = process.cwd();
    const memoryEnabled = process.env.MEMORY_ENABLED;
    process.chdir(root);
    process.env.MEMORY_ENABLED = 'true';
    __resetAdoptionForTests();
    __resetMemoryPauseForTests();
    try {
      await fn();
    } finally {
      setMemoryWritesPaused(false);
      __resetMemoryPauseForTests();
      __resetAdoptionForTests();
      process.chdir(cwd);
      if (memoryEnabled === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = memoryEnabled;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const ledgerFile = (): string => join(process.cwd(), '.mocode', 'memory-adoption.jsonl');
const summaryFile = (): string => join(process.cwd(), '.mocode', 'memory-adoption-summary.json');

test(
  'R19:送达与抑制分别入账；抑制不进入待评估分母',
  isolated(() => {
    const delivery = recordMemoryDelivery('unique-items', 'proactive_trigger');
    assert.ok(delivery, '真实送达应有可引用的 delivery id');
    recordMemorySuppression('unique-items', 'proactive_trigger', 'already_fired');

    const stats = adoptionStats();
    assert.equal(stats.delivered, 1);
    assert.equal(stats.pending, 1);
    assert.equal(stats.suppressed, 1);
    assert.equal(stats.byChannel.proactive_trigger, 1);
    assert.equal(stats.suppressedByReason.already_fired, 1);
    assert.equal(adoptionEvents().length, 2);
  }),
);

test(
  'R19:只接受当前待评估的真实送达；伪造与重复裁决都被忽略',
  isolated(() => {
    const delivery = recordMemoryDelivery('memory-a', 'turn_recall');
    assert.ok(delivery);
    const applied = applyAdoptionEvaluations([
      { deliveryId: 'forged-delivery', verdict: 'adopted', reason: '伪造 id' },
      { deliveryId: delivery, verdict: 'adopted', reason: '后续工具动作明确采用了提醒' },
      { deliveryId: delivery, verdict: 'unclear', reason: '不能覆盖第一次结论' },
    ]);

    assert.equal(applied, 1);
    const stats = adoptionStats();
    assert.equal(stats.evaluated, 1);
    assert.equal(stats.adopted, 1);
    assert.equal(stats.unclear, 0);
    assert.equal(stats.pending, 0);
    assert.equal(applyAdoptionEvaluations([{ deliveryId: delivery, verdict: 'unclear' }]), 0);
  }),
);

test(
  'R19:评估指令只列待评估送达；提取会剥离摘要附段并忽略坏行和重复项',
  isolated(() => {
    const delivery = recordMemoryDelivery('memory-b', 'memory_tail');
    assert.ok(delivery);
    const instruction = adoptionEvaluationInstruction('reflection');
    assert.match(instruction, new RegExp(`deliveryId=${delivery}`));
    assert.match(instruction, /adoptions/);

    const raw = [
      '## Completed',
      '保留给摘要的正文',
      '',
      '## Memory Adoptions',
      `- {"deliveryId":"${delivery}","verdict":"not_applicable","reason":"后续任务改为另一条路径"}`,
      '- {not json}',
      `- {"deliveryId":"${delivery}","verdict":"adopted"}`,
      '',
      '## Key Facts',
      '正文继续保留',
    ].join('\n');
    const extracted = extractAdoptionEvaluations(raw);
    assert.equal(extracted.evaluations.length, 1);
    assert.equal(extracted.evaluations[0].verdict, 'not_applicable');
    assert.doesNotMatch(extracted.text, /Memory Adoptions|not_applicable/);
    assert.match(extracted.text, /## Completed|## Key Facts/);
  }),
);

test(
  'R19:90 天外明细压为累计汇总，近期未评估送达仍保留可裁决',
  isolated(() => {
    const dir = join(process.cwd(), '.mocode');
    mkdirSync(dir, { recursive: true });
    const oldAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const recentAt = new Date(Date.now() - 1_000).toISOString();
    const oldDelivery = { id: 'old-delivery', at: oldAt, memoryId: 'old', channel: 'anchor_read', kind: 'delivered' };
    const oldEvaluation = {
      id: 'old-evaluation',
      at: oldAt,
      memoryId: 'old',
      channel: 'anchor_read',
      kind: 'evaluated',
      deliveryId: 'old-delivery',
      verdict: 'adopted',
    };
    const recentDelivery = {
      id: 'recent-delivery',
      at: recentAt,
      memoryId: 'recent',
      channel: 'turn_recall',
      kind: 'delivered',
    };
    writeFileSync(
      ledgerFile(),
      [oldDelivery, oldEvaluation, recentDelivery].map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
    // 注意:这条用例依赖 prune 同时做 90 天归档与抑制去重，两者不能互相吞掉。

    pruneAdoptionLedger(Date.now());

    assert.ok(existsSync(summaryFile()), '历史聚合应单独落盘');
    const retained = readFileSync(ledgerFile(), 'utf8');
    assert.doesNotMatch(retained, /old-delivery/);
    assert.match(retained, /recent-delivery/);
    const stats = adoptionStats();
    assert.equal(stats.delivered, 2);
    assert.equal(stats.adopted, 1);
    assert.equal(stats.pending, 1, '仅近期未评估送达仍是 pending');
    assert.equal(
      pendingAdoptionDeliveries()
        .map((e) => e.id)
        .join(','),
      'recent-delivery',
    );
  }),
);

test(
  'R19:记忆关闭或暂停时账本零写入',
  isolated(() => {
    process.env.MEMORY_ENABLED = 'false';
    assert.equal(recordMemoryDelivery('off', 'turn_recall'), null);
    assert.equal(existsSync(ledgerFile()), false);

    process.env.MEMORY_ENABLED = 'true';
    setMemoryWritesPaused(true);
    assert.equal(recordMemoryDelivery('paused', 'turn_recall'), null);
    recordMemorySuppression('paused', 'turn_recall', 'read_file_dedup');
    assert.equal(existsSync(ledgerFile()), false);
  }),
);

test(
  'R19:同一抑制在内存聚合成一行，flush 后才落盘且次数完整',
  isolated(() => {
    for (let i = 0; i < 25; i++) recordMemorySuppression('noisy', 'proactive_trigger', 'already_fired');
    recordMemorySuppression('noisy', 'proactive_trigger', 'per_turn_limit');

    // 未 flush 时账本还没写:抑制不再是每工具调用一次 appendFileSync。
    assert.equal(existsSync(ledgerFile()), false, '抑制只进内存桶，不应逐条落盘');
    // 但读路径要能看到本轮刚发生的抑制(未落盘也不能丢)。
    assert.equal(adoptionStats().suppressed, 26);
    assert.equal(adoptionStats().suppressedByReason.already_fired, 25);

    flushAdoptionSuppressions();
    const lines = readFileSync(ledgerFile(), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2, '25 次 already_fired 压成 1 行，另一个 reason 另占 1 行');
    const already = lines.map((l) => JSON.parse(l)).find((e) => e.reason === 'already_fired');
    assert.equal(already.count, 25);
    assert.equal(already.kind, 'suppressed');

    // flush 后桶被清空，再统计不能翻倍。
    assert.equal(adoptionStats().suppressed, 26);
    flushAdoptionSuppressions();
    assert.equal(readFileSync(ledgerFile(), 'utf8').split('\n').filter(Boolean).length, 2, '空桶 flush 不写任何行');
  }),
);

test(
  'R19:历史逐条抑制行在 prune 时被合并，不需要等到 90 天过期',
  isolated(() => {
    const now = Date.now();
    const at = new Date(now - 60_000).toISOString();
    const rows = [];
    for (let i = 0; i < 12; i++)
      rows.push({
        id: `legacy-${i}`,
        at,
        sessionId: 's1',
        memoryId: 'legacy',
        channel: 'proactive_trigger',
        kind: 'suppressed',
        reason: 'already_fired',
      });
    rows.push({ id: 'keep-me', at, memoryId: 'kept', channel: 'turn_recall', kind: 'delivered' });
    mkdirSync(join(process.cwd(), '.mocode'), { recursive: true });
    writeFileSync(ledgerFile(), rows.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const before = adoptionStats();
    pruneAdoptionLedger(now);

    const lines = readFileSync(ledgerFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2, '12 条逐条抑制压成 1 条聚合行，delivered 原样保留');
    assert.equal(lines.filter((e) => e.kind === 'delivered').length, 1);
    assert.equal(lines.find((e) => e.kind === 'suppressed').count, 12);
    assert.equal(existsSync(summaryFile()), false, '没有 90 天外事件时不该产生历史汇总');

    // 压缩前后口径必须一致:计数不因合并而变。
    const after = adoptionStats();
    assert.equal(after.suppressed, before.suppressed);
    assert.equal(after.suppressedByReason.already_fired, before.suppressedByReason.already_fired);
    assert.equal(after.delivered, before.delivered);
    assert.equal(after.pending, 1);
  }),
);

test(
  'R19:聚合行与逐条混存时按 count 累加，不会把一条算成一次',
  isolated(() => {
    const now = Date.now();
    const at = new Date(now - 60_000).toISOString();
    mkdirSync(join(process.cwd(), '.mocode'), { recursive: true });
    writeFileSync(
      ledgerFile(),
      [
        {
          id: 'a',
          at,
          sessionId: 's',
          memoryId: 'm',
          channel: 'turn_recall',
          kind: 'suppressed',
          reason: 'per_turn_limit',
          count: 9,
        },
        {
          id: 'b',
          at,
          sessionId: 's',
          memoryId: 'm',
          channel: 'turn_recall',
          kind: 'suppressed',
          reason: 'per_turn_limit',
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
      'utf8',
    );

    assert.equal(adoptionStats().suppressed, 10);
    pruneAdoptionLedger(now);
    assert.equal(adoptionStats().suppressed, 10, '合并后总数必须仍是 10');
  }),
);
