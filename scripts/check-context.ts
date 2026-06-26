// 离线验证上下文工程核心逻辑(不连后端):
//   estimateTokens / capToolResultForHistory / compactHistory
//   的 grouping 配对不变量、原地修改、system 保留、摘要插入。
// 运行:npx tsx scripts/check-context.ts
//
// 先设 dummy env 避免 config.requireEnv 退出,再用动态 import(静态 import 会先于 env 设置执行)。
// 注入假 summarize 避免真实 API 调用。

import type { ChatMessage } from '../src/llm/index.js';

(async () => {
  process.env.LLM_BASE_URL ||= 'http://localhost/v1';
  process.env.LLM_API_KEY ||= 'x';
  process.env.LLM_MODEL ||= 'x';

  const assert = (cond: boolean, msg: string): void => {
    if (!cond) {
      console.error('✗ ' + msg);
      process.exit(1);
    }
    console.log('✓ ' + msg);
  };

  const { estimateTokens, estimateMessagesTokens } = await import(
    '../src/llm/index.js'
  );
  const { compactHistory, capToolResultForHistory } = await import(
    '../src/session/compact.js'
  );

  // 1) estimateTokens:CJK 过估(安全侧),ASCII ≈ chars/4
  assert(estimateTokens('你好世界') >= 4, "estimateTokens('你好世界') >= 4");
  assert(estimateTokens('hello world') === 3, "estimateTokens('hello world') === 3");
  assert(estimateTokens('') === 0, "estimateTokens('') === 0");

  // 2) capToolResultForHistory:超长裁到上限内 + 标记;短结果不裁
  const big = 'X'.repeat(20000);
  const capped = capToolResultForHistory('run_command', big);
  assert(capped.length <= 8000, 'capToolResultForHistory 裁到 <= 8000');
  assert(capped.includes('已截断'), 'capToolResultForHistory 含已截断标记');
  assert(
    capToolResultForHistory('read_file', 'short') === 'short',
    '短结果不裁'
  );

  // 3) compactHistory:grouping 不变量 + 原地 + system 保留 + 摘要插入
  //    设计:旧组(含 50000 字符的 tool_a)被微压缩+摘要丢弃;近期组(asst_b+tool_b)保留。
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' } as ChatMessage,
    { role: 'user', content: 'u1' } as ChatMessage,
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'run_command', arguments: '{}' } },
      ],
    } as ChatMessage,
    { role: 'tool', tool_call_id: 'call_a', content: 'T'.repeat(50000) } as ChatMessage,
    { role: 'assistant', content: 'a_mid' } as ChatMessage,
    { role: 'user', content: 'u2' } as ChatMessage,
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ],
    } as ChatMessage,
    { role: 'tool', tool_call_id: 'call_b', content: 'small result' } as ChatMessage,
  ];

  const before = estimateMessagesTokens(history);
  const r = await compactHistory(history, {
    window: 1000,
    threshold: 0.5,
    summarize: async () => '用户做了某事', // 注入假摘要器,避免真 API
  });
  const after = estimateMessagesTokens(history);

  assert(r.compacted, 'compactHistory.compacted === true');
  assert(after < before, `压缩后 token 降(${before} → ${after})`);

  // 系统提示保留在 index 0
  assert(
    history[0].role === 'system' && (history[0] as any).content === 'sys',
    'history[0] 仍是原 system 提示'
  );

  // 摘要插在 index 1
  assert(
    history[1].role === 'system' &&
      String((history[1] as any).content).includes('会话摘要'),
    'history[1] 是摘要 system 消息'
  );

  // 关键不变量:每条存活的 tool 消息都有前导 assistant 含同 id 的 tool_calls(无孤儿)
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'tool') {
      const tcid = (history[i] as any).tool_call_id;
      let j = i - 1;
      while (j >= 0 && history[j].role === 'tool') j--; // 跳过连续 tool
      let found = false;
      if (j >= 0 && history[j].role === 'assistant') {
        const tcs = (history[j] as any).tool_calls as { id: string }[] | undefined;
        found = !!tcs?.some((t) => t.id === tcid);
      }
      assert(found, `压缩后 tool_call_id ${tcid} 仍配对(无孤儿)`);
    }
  }

  // 原地修改:同一数组引用,长度变小
  assert(history.length < 8, 'history 原地重建(长度变小,引用不变)');

  console.log(`\nOK: ${before} → ${after} tokens, ${history.length} 条消息`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
