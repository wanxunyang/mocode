/**
 * 流式 markdown 渲染节流的判定逻辑(2026-10-05)。
 *
 * 背景:contentWriteMd 原实现每收到一个 onText chunk 就把累积的整个 mdBuf 重渲一遍,
 * O(n²)(实测 5879 字符回复 →~1960 chunk → 累计扫描 5.5MB / ~900ms 纯 CPU,且全程
 * 同步阻塞事件循环)。改为按节流渲染后,判定函数是纯逻辑,可在无 TTY 的单测里覆盖。
 *
 * 这里只测判定;渲染时序(定时器补渲 / commitMd 强制 flush)依赖真 TTY,由人工与
 * 交互层验证。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldRenderMdSegment } from '../src/ui/layout-internal/content-write.js';

describe('流式 markdown 渲染节流判定', () => {
  it('间隔未到且未攒够突发量 → 只累积不渲染(节流生效)', () => {
    // 高速后端的典型 chunk:3 字符、间隔 5ms。连续若干次都不应触发渲染,
    // 否则节流失效、回到「每 chunk 重渲」的 O(n²)。
    for (let i = 0; i < 6; i++) {
      assert.equal(shouldRenderMdSegment(5, 3), false, `第 ${i} 次:5ms/3字符 不该渲染`);
    }
  });

  it('间隔达到阈值 → 渲染(时间节流主路径)', () => {
    assert.equal(shouldRenderMdSegment(32, 1), true);
    assert.equal(shouldRenderMdSegment(100, 1), true);
  });

  it('突发大 chunk 即使间隔未到也渲染(防饿死)', () => {
    // 后端一次性吐整段代码:距上次渲染才 1ms,但已攒了上千字符,不该再等 32ms。
    assert.equal(shouldRenderMdSegment(1, 4096), true);
  });

  it('突发阈值足够大:一个间隔内的正常累积量不会抢在时间节流前面', () => {
    // 这是取 512 而非 64 的原因。高速流(5ms/chunk)在 32ms 内约累积 6~7 个 chunk,
    // 若阈值取小(如 64),每 2 个 chunk 就会触发一次 → 时间维度失效。
    // 这里锁住「32ms 内正常流最多攒 ~40 字符」这一量级,确保远低于 512。
    const chunksPerInterval = Math.ceil(32 / 5); // ≈7
    const charsPerInterval = chunksPerInterval * 3; // ≈21
    assert.ok(charsPerInterval < 512, `正常流 32ms 内累积 ${charsPerInterval} 字符应远低于突发阈值`);
    assert.equal(shouldRenderMdSegment(30, charsPerInterval), false);
  });

  it('慢速后端(每 chunk 间隔已超阈值)不做无谓节流', () => {
    // 60ms/chunk 的后端:每个 chunk 本来就该上屏,节流不应额外推迟(否则观感变差)。
    assert.equal(shouldRenderMdSegment(60, 4), true);
  });
});
