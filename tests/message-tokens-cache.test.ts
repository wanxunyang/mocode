/**
 * messageTokens 内容签名缓存(2026-10-05)的正确性护栏。
 *
 * 背景:token 估算是 80% 压力线的唯一依据,估算偏低 → 压缩不触发 → prompt 实际已超窗口
 * (见 llm/index.ts 的 imageTokens 注释:「模型突然抽风」)。所以加缓存后,**原地改写
 * message.content 必须被正确识别**,否则会静默低估。
 *
 * 仓库里有 4 处原地改写:age-aware.ts / artifacts.ts(标 stale) / compact.ts ×2(微压缩)。
 * 本测试直接覆盖这个契约,不依赖那 4 处的具体调用路径。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { messageTokens, estimateMessagesTokens } from '../src/llm/index.js';
import type { ChatMessage } from '../src/llm/index.js';

const toolMsg = (content: string): ChatMessage => ({ role: 'tool', content, tool_call_id: 't1' }) as ChatMessage;

describe('messageTokens 内容签名缓存', () => {
  it('同一对象重复估算返回相同结果(命中缓存)', () => {
    const m = toolMsg('x'.repeat(10_000));
    const first = messageTokens(m);
    const second = messageTokens(m);
    assert.equal(first, second);
  });

  it('原地改写 content(微压缩截断)后重新估算,不得返回旧值', () => {
    const original = 'y'.repeat(50_000);
    const m = toolMsg(original);
    const before = messageTokens(m);

    // 复刻 compact.ts:590 的微压缩:原地截短同一对象
    (m as { content: unknown }).content = 'y'.repeat(600);
    const after = messageTokens(m);

    assert.ok(after < before, `截断后估算应显著变小:before=${before} after=${after}`);
    // 更强断言:必须等于「当作新对象算」的结果
    const fresh = messageTokens(toolMsg('y'.repeat(600)));
    assert.equal(after, fresh, '改写后的估算必须与同内容新对象一致,不能是脏数据');
  });

  it('原地改写为「字符长度相同」的内容:签名按 length 判定,仍能抓到变化', () => {
    // 签名含 `content.length`(UTF-16 code unit 数)。ASCII 与 CJK 混排时
    // 「字符数相同但 code unit 数不同」→ 签名变化 → 正确重算。
    // 本例 1000 个 ASCII(1000 code unit) → 500 个 CJK(500 code unit)。
    const m = toolMsg('a'.repeat(1000));
    const before = messageTokens(m);
    (m as { content: unknown }).content = '中'.repeat(500);
    const after = messageTokens(m);
    const fresh = messageTokens(toolMsg('中'.repeat(500)));
    assert.equal(after, fresh, '必须与同内容新对象一致');
    assert.ok(after > before, `CJK 密度高,token 应上升:before=${before} after=${after}`);
  });

  it('已知局限:严格等长且 token 也相同的改写会命中缓存', () => {
    // 签名只含length,不含内容哈希。故「长度与 token 估算都相同」的改写(如
    // 'a'*1000 → 'b'*1000)会复用旧值。本测试把这个边界显式记录下来 ——
    // 仓库里的 4 处原地改写(age-aware / artifacts / compact ×2)都是**截短**
    // 或整体替换标记,不会触发此路径;真要收紧需把内容哈希纳入签名(代价是 O(n) 重建)。
    const m = toolMsg('a'.repeat(1000));
    const before = messageTokens(m);
    (m as { content: unknown }).content = 'b'.repeat(1000);
    const after = messageTokens(m);
    assert.equal(after, before, '等长且等价密度改写命中缓存 —— 签名方案的既定边界');
  });

  it('tool_calls 参数变化也应被识别', () => {
    const base = { role: 'assistant', content: 'ok' } as ChatMessage;
    const withCalls = {
      role: 'assistant',
      content: 'ok',
      tool_calls: [{ id: '1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
    } as unknown as ChatMessage;
    const a = messageTokens(base);
    const b = messageTokens(withCalls);
    assert.ok(b > a, '带 tool_calls 的消息估算应更大');
  });

  it('estimateMessagesTokens: 改写其中一条后总量随之下降', () => {
    const a = toolMsg('a'.repeat(20_000));
    const b = toolMsg('b'.repeat(20_000));
    const c = toolMsg('c'.repeat(20_000));
    const history: ChatMessage[] = [a, b, c];

    const before = estimateMessagesTokens(history);
    (b as { content: unknown }).content = 'b'; // 复刻 artifacts.ts:269 标 stale
    const after = estimateMessagesTokens(history);
    assert.ok(after < before, `单条改写后总量应下降:before=${before} after=${after}`);
  });

  it('role 变化会改变结构开销(签名含 role)', () => {
    const m = { role: 'user', content: 'hello' } as ChatMessage;
    const asUser = messageTokens(m);
    (m as { role: string }).role = 'system';
    const asSystem = messageTokens(m);
    assert.equal(asSystem, asUser - 1, 'system 的结构开销比 user 少 1');
  });
});
