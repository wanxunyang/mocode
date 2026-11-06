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
  pendingAdoptionDeliveries,
  pruneAdoptionLedger,
  recordMemoryDelivery,
  recordMemorySuppression,
} from '../src/memory/adoption.js';
import { setMemoryWritesPaused, __resetMemoryPauseForTests } from '../src/memory/write-gate.js';

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
