import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatUsageSummary, summarizeUsage, toUsageRecord, type UsageRecord } from '../src/session/usage-stats.js';
import type { ChatUsage } from '../src/llm/index.js';

function usage(over: Partial<ChatUsage> = {}): ChatUsage {
  return {
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    cachedTokens: 800,
    reasoningTokens: 50,
    ...over,
  };
}

describe('toUsageRecord', () => {
  it('returns null when usage missing', () => {
    assert.equal(toUsageRecord(0, 'main', undefined), null);
  });

  it('maps fields and omits optional keys when zero/absent', () => {
    const r = toUsageRecord(3, 'main', usage(), 1100)!;
    assert.equal(r.step, 3);
    assert.equal(r.phase, 'main');
    assert.equal(r.inputTokens, 1000);
    assert.equal(r.cachedTokens, 800);
    assert.equal(r.estimatedTotal, 1100);
    assert.equal('cacheCreationTokens' in r, false);
  });
});

describe('summarizeUsage', () => {
  const recs: UsageRecord[] = [
    toUsageRecord(0, 'main', usage(), 1100)!,
    toUsageRecord(1, 'compact', usage({ promptTokens: 500, cachedTokens: 450 }))!,
    toUsageRecord(2, 'main', usage({ promptTokens: 1200, cachedTokens: 1000, reasoningTokens: 0 }), 1100)!,
  ];

  it('splits phases and totals', () => {
    const s = summarizeUsage(recs);
    assert.equal(s.records, 3);
    assert.equal(s.compactCalls, 1);
    assert.equal(s.main.calls, 2);
    assert.equal(s.main.input, 2200);
    assert.equal(s.compact.input, 500);
    assert.equal(s.total.input, 2700);
    assert.equal(s.total.cached, 2250);
  });

  it('computes hit rates', () => {
    const s = summarizeUsage(recs);
    assert.ok(Math.abs((s.cacheHitRate ?? 0) - 2250 / 2700) < 1e-9);
    assert.ok(Math.abs((s.compactCacheHitRate ?? 0) - 0.9) < 1e-9);
  });

  it('reports n/a hit rates when backend never reports cached', () => {
    const noCache = [toUsageRecord(0, 'main', usage({ cachedTokens: 0 }))!];
    const s = summarizeUsage(noCache);
    assert.equal(s.cacheHitRate, null);
    assert.equal(s.mainCacheHitRate, null);
  });

  it('computes reasoning share and estimate ratio', () => {
    const s = summarizeUsage(recs);
    assert.equal(s.reasoningShare, 100 / 600);
    assert.ok(Math.abs((s.estimateRatio ?? 0) - 1) < 1e-9);
  });

  it('format renders without throwing and includes n/a fallback', () => {
    const text = formatUsageSummary(summarizeUsage([toUsageRecord(0, 'main', usage({ cachedTokens: 0 }))!]));
    assert.match(text, /n\/a/);
  });
});
