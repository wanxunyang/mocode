/**
 * R3 前摄通道:让记忆在踩坑之前自己出现。
 *
 * 覆盖点(与 design-notes/memory/memory.md §R3 逐条对应):
 *  - R3.1 索引只收「有 trigger + active + 高价值类型」的条目
 *  - R3.2 参数规范化:去引号、反斜杠转正斜杠、剥工作区前缀、合并空白
 *  - R3.2 泛化词过滤:只命中「代码/文件」这类词不得触发
 *  - R3.4 同一条进程内只弹一次;每轮上限;resetProactiveTurn 归零
 *  - R3.5 开关:proactiveHint(enabled=false) 不注入;MOCODE_MEMORY_PROACTIVE 可单独关
 *  - R3.3 dispatcher 端到端:成功结果尾部带提醒;memory 总开关关闭时不注入
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalizeContext,
  isProactiveEnabled,
  matchProactive,
  normalizeArgsText,
  proactiveFiredIds,
  proactiveHint,
  proactiveTurnCount,
  resetProactiveTurn,
  __resetProactiveForTests,
} from '../src/memory/proactive.js';
import { saveEntry, updateEntry } from '../src/memory/store.js';
import { memoryListTool } from '../src/tools/builtins/memory-list.js';
import { createStagedToolDispatcher } from '../src/agent/stages/tool-dispatcher.js';
import { clearToolsExtension, registerToolsExtension } from '../src/tools/registry.js';
import { createReadDedup } from '../src/tools/read-dedup.js';
import type { Tool } from '../src/tools/types.js';
import type { ToolCallRef } from '../src/llm/index.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    // home 与 proj 必须分离:同目录会让 global/project 两个 JSONL 指向同一文件。
    const root = mkdtempSync(join(tmpdir(), 'mocode-proactive-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const cwd = process.cwd();
    const memEnv = process.env.MEMORY_ENABLED;
    const proEnv = process.env.MOCODE_MEMORY_PROACTIVE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projDir);
    process.env.MEMORY_ENABLED = 'true';
    delete process.env.MOCODE_MEMORY_PROACTIVE;
    __resetProactiveForTests();
    try {
      await fn();
    } finally {
      __resetProactiveForTests();
      process.env.HOME = home ?? '';
      process.env.USERPROFILE = up ?? '';
      if (home === undefined) delete process.env.HOME;
      if (up === undefined) delete process.env.USERPROFILE;
      if (memEnv === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = memEnv;
      if (proEnv === undefined) delete process.env.MOCODE_MEMORY_PROACTIVE;
      else process.env.MOCODE_MEMORY_PROACTIVE = proEnv;
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/**
 * 当前用户轮文本。R3 的匹配必须带上它:trigger 是自然语言场景描述,
 * 工具参数只有路径片段,单靠参数重合度不足以达到阈值。
 */
const CTX = '我在调 dashscope compatible-mode,构造工具 schema 时一直 400';

/** 写一条带 trigger 的 pitfall,内容围绕"构造 dashscope 工具 schema"。 */
function seedPitfall(name = 'kimi-k3-uniqueitems', trigger?: string): void {
  const r = saveEntry({
    name,
    summary: 'dashscope compatible-mode 拒收 uniqueItems',
    body: 'schema 里带 uniqueItems 会整请求 400',
    type: 'pitfall',
    trigger: trigger ?? '构造工具 schema 并发送给 dashscope compatible-mode 时',
    action: '递归剔除 uniqueItems 再发送',
  });
  assert.ok(r.ok, '前置:种子条目应写入成功');
}

// ── R3.2 规范化 ────────────────────────────────────────────────────────────

test('normalizeArgsText: 递归展开对象/数组,忽略 null', () => {
  const text = normalizeArgsText({
    path: 'src/llm/tool-schema.ts',
    nested: { flag: true, n: 3 },
    list: ['a', null, 'b'],
    missing: null,
  });
  assert.match(text, /src\/llm\/tool-schema\.ts/);
  assert.match(text, /true/);
  // 空值贡献空串,拼接后是 'a  b';这里只断言两段都在(空白合并在 canonicalizeContext 做)
  assert.match(text, /a\s+b/);
  assert.doesNotMatch(text, /null/);
});

test('normalizeArgsText: 深度上限内不无限递归', () => {
  const deep = { a: { b: { c: { d: { e: { f: 'too-deep' } } } } } };
  const text = normalizeArgsText(deep);
  assert.doesNotMatch(text, /too-deep/, '超过深度上限应被截断');
});

test('canonicalizeContext: 去引号、反斜杠转正斜杠、剥工作区前缀、合并空白', () => {
  const cwd = process.cwd().replace(/\\/g, '/');
  // 反斜杠路径 + 引号 + 双空格
  const raw = `read_file  "${cwd}\\src\\llm\\tool-schema.ts"   hello`;
  const out = canonicalizeContext(raw);
  assert.doesNotMatch(out, /"/, '引号应去掉');
  assert.doesNotMatch(out, /\\/, '反斜杠应转正斜杠');
  assert.match(out, /src\/llm\/tool-schema\.ts/, '应保留相对路径部分');
  assert.doesNotMatch(out, /\s{2,}/, '空白应合并');
  // 前缀剥离后不应残留工作区绝对前缀
  assert.ok(!out.includes(cwd.toLowerCase()), '工作区前缀应被剥掉');
});

// ── R3.1 索引资格 ──────────────────────────────────────────────────────────

test(
  'R3.1: 只有「active + 有 trigger + 高价值类型」的条目进索引',
  isolated(() => {
    seedPitfall();
    // fact 无 trigger → 不入索引
    assert.ok(saveEntry({ name: 'plain-fact', summary: '实测事实', body: 'b', type: 'fact' }).ok);
    // fact 带 trigger 也不行(fact 非条件-动作式)
    assert.ok(
      saveEntry({
        name: 'fact-with-trigger',
        summary: '实测事实二',
        body: 'b',
        type: 'fact',
        trigger: '构造工具 schema 并发送给 dashscope 时',
      }).ok,
    );

    const matches = matchProactive('write_file', { path: 'src/llm/tool-schema.ts' }, CTX);
    const ids = matches.map((m) => m.entry.id);
    assert.ok(ids.includes('kimi-k3-uniqueitems'), 'pitfall + trigger 应进索引');
    assert.ok(!ids.includes('plain-fact'), '无 trigger 的 fact 不入索引');
    assert.ok(!ids.includes('fact-with-trigger'), 'fact 即便有 trigger 也不作前摄(非条件-动作式)');
  }),
);

test(
  'R3.1: pinned 条目即使类型是 fact 也可进索引(用户显式置顶)',
  isolated(() => {
    assert.ok(
      saveEntry({
        name: 'pinned-fact',
        summary: '置顶的实测事实',
        body: 'b',
        type: 'fact',
        pinned: true,
        trigger: '构造工具 schema 发送给 dashscope compatible-mode 时',
      }).ok,
    );
    const ids = matchProactive('write_file', { path: 'src/llm/tool-schema.ts' }, CTX).map((m) => m.entry.id);
    assert.ok(ids.includes('pinned-fact'), 'pinned 应绕过类型限制');
  }),
);

// ── R3.2 匹配质量 ──────────────────────────────────────────────────────────

test(
  'R3.2: 只命中泛化词不触发(防止"涉及代码"这类 trigger 弹一切)',
  isolated(() => {
    seedPitfall();
    // 仅"工具""文件""代码"这些泛化词 → 不该命中
    const matches = matchProactive('write_file', { path: 'tool-schema.ts' });
    assert.equal(matches.length, 0, '泛化词单独命中不足以触发');

    // 加上真正的区分词(dashscope / uniqueItems) → 命中
    const hit = matchProactive('write_file', { path: 'src/llm/tool-schema.ts', note: 'dashscope schema' });
    assert.ok(hit.length > 0, '出现区分词后应命中');
  }),
);

test(
  'R3.2: 命中数与阈值——单个词元不足以触发',
  isolated(() => {
    seedPitfall();
    const matches = matchProactive('run_command', { command: 'dashscope' });
    // "dashscope" 单词命中,达不到 MIN_MATCHED_TOKENS(2)
    assert.equal(matches.length, 0, '单个词元命中不应触发');
  }),
);

test(
  'R3.2: 上下文过短直接跳过(不白烧匹配)',
  isolated(() => {
    seedPitfall();
    assert.deepEqual(matchProactive('write_file', null), []);
    assert.deepEqual(matchProactive('x', {}), []);
  }),
);

// ── R3.4 冷却与限额 ────────────────────────────────────────────────────────

test(
  'R3.4: 同一条记忆在同一进程内只弹一次',
  isolated(() => {
    seedPitfall();
    const args = { path: 'src/llm/tool-schema.ts', note: 'dashscope schema uniqueItems' };
    const first = proactiveHint('write_file', args, true, CTX);
    assert.ok(first.includes('kimi-k3-uniqueitems'), '首次应注入');
    assert.match(first, /when:/, '应带 when 行');
    assert.match(first, /do:/, '应带 do 行');

    const second = proactiveHint('write_file', args, true, CTX);
    assert.equal(second, '', '同一条不应重复弹');
    assert.deepEqual(proactiveFiredIds(), ['kimi-k3-uniqueitems']);
  }),
);

test(
  'R3.4: 每轮上限 3 次,resetProactiveTurn 归零',
  isolated(() => {
    for (let i = 0; i < 5; i++) {
      assert.ok(
        saveEntry({
          name: `pitfall-${i}`,
          summary: `第 ${i} 条坑`,
          body: 'b',
          type: 'pitfall',
          trigger: `构造工具 schema 第 ${i} 阶段并发送给 dashscope compatible-mode 时`,
          action: `动作 ${i}`,
        }).ok,
      );
    }
    const args = { path: 'src/llm/tool-schema.ts', note: 'dashscope schema 构造工具 compatible-mode' };
    const fired: string[] = [];
    for (let i = 0; i < 5; i++) {
      const h = proactiveHint('write_file', args, true, CTX);
      if (h) fired.push(h);
    }
    assert.equal(fired.length, 3, '每轮最多 3 次');
    assert.equal(proactiveTurnCount(), 3);
    const firedBefore = new Set(proactiveFiredIds());
    assert.equal(firedBefore.size, 3, '三轮各弹一条不同的');

    // 新一轮 → 轮限额归零,可以再弹(但只弹此前没弹过的条目)
    resetProactiveTurn();
    assert.equal(proactiveTurnCount(), 0);
    const afterReset = proactiveHint('write_file', args, true, CTX);
    assert.ok(afterReset.length > 0, '新的一轮应恢复注入能力(按轮而非按进程限流)');
    for (const id of firedBefore) {
      assert.ok(!afterReset.includes(`[${id}]`), `已弹过的 ${id} 不应重复`);
    }
  }),
);

// ── R3.5 开关 ──────────────────────────────────────────────────────────────

test('R3.5: enabled=false 时零注入;开关 env 可单独关闭', () => {
  assert.equal(proactiveHint('write_file', { path: 'x' }, false), '', '总开关关闭时不注入');

  delete process.env.MOCODE_MEMORY_PROACTIVE;
  assert.equal(isProactiveEnabled(), true, '默认开启');
  for (const v of ['0', 'false', 'off', 'no', 'FALSE']) {
    process.env.MOCODE_MEMORY_PROACTIVE = v;
    assert.equal(isProactiveEnabled(), false, `=${v} 应关闭`);
  }
  process.env.MOCODE_MEMORY_PROACTIVE = '1';
  assert.equal(isProactiveEnabled(), true);
  delete process.env.MOCODE_MEMORY_PROACTIVE;
});

test(
  'R3.3: memory_* 与 ask_human 等工具不注入(避免自我循环/噪声)',
  isolated(() => {
    seedPitfall();
    const args = { query: 'dashscope schema 构造工具 uniqueItems' };
    assert.equal(proactiveHint('memory_search', args, true), '', 'memory_search 不注入');
    assert.equal(proactiveHint('memory_save', args, true), '', 'memory_save 不注入');
    assert.equal(proactiveHint('ask_human', args, true), '', 'ask_human 不注入');
    assert.equal(proactiveTurnCount(), 0, '跳过时不消耗限额');
  }),
);

// ── 索引缓存 ───────────────────────────────────────────────────────────────

test(
  '索引随记忆文件变更失效(新增条目无需重启)',
  isolated(() => {
    assert.equal(matchProactive('write_file', { path: 'src/x.ts', note: 'dashscope schema' }).length, 0);
    seedPitfall();
    const after = matchProactive('write_file', { path: 'src/x.ts', note: 'dashscope schema' });
    assert.ok(after.length > 0, '新增条目后应立刻可命中(缓存按文件指纹失效)');
  }),
);

// ── R3.3 dispatcher 端到端 ─────────────────────────────────────────────────

function makeReadTool(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    capabilities: { effect: 'read', concurrency: 'parallel' },
    async execute() {
      return 'file content';
    },
  };
}

async function dispatchOnce(toolName: string, args: Record<string, unknown>): Promise<string> {
  const source = 'proactive-test';
  registerToolsExtension(source, [makeReadTool(toolName)]);
  try {
    const dispatcher = createStagedToolDispatcher();
    const call: ToolCallRef = { id: 'c1', name: toolName, arguments: JSON.stringify(args) };
    const result = await dispatcher.dispatch({
      calls: [call],
      policy: {
        mode: 'auto',
        tools: [],
        allowedToolNames: new Set([toolName]),
        reminder: '',
      },
      isDenied: () => false,
      currentAllowedToolNames: () => [toolName],
      delegation: () => ({ history: [], tools: [] }),
      readDedup: createReadDedup(),
      argumentErrorHint: () => undefined,
      onEvent: () => {},
    });
    return result.orderedResults[0]?.outcome.output ?? '';
  } finally {
    clearToolsExtension(source);
  }
}

test(
  'R3.3 dispatcher: 命中时把 when/do 前置到工具结果尾部',
  isolated(async () => {
    seedPitfall();
    const out = await dispatchOnce('probe_read', {
      path: 'src/llm/tool-schema.ts',
      note: 'dashscope schema uniqueItems',
    });
    assert.match(out, /file content/, '原始结果必须保留');
    assert.match(out, /\[proactive memory\]/, '应追加提醒段');
    assert.match(out, /kimi-k3-uniqueitems/);
    assert.match(out, /递归剔除 uniqueItems 再发送/, 'action 应出现在提醒里');
  }),
);

test(
  'R3.5 dispatcher: MEMORY_ENABLED=false 时即便命中也不注入(总开关 veto)',
  isolated(async () => {
    seedPitfall();
    process.env.MEMORY_ENABLED = 'false';
    const out = await dispatchOnce('probe_read2', {
      path: 'src/llm/tool-schema.ts',
      note: 'dashscope schema uniqueItems',
    });
    assert.equal(out, 'file content', '总开关关闭时不得追加任何提醒');
  }),
);

test(
  'R3.5 dispatcher: MOCODE_MEMORY_PROACTIVE=0 时单独关闭前摄',
  isolated(async () => {
    seedPitfall();
    process.env.MOCODE_MEMORY_PROACTIVE = '0';
    const out = await dispatchOnce('probe_read3', {
      path: 'src/llm/tool-schema.ts',
      note: 'dashscope schema uniqueItems',
    });
    assert.equal(out, 'file content', '独立开关关闭时不注入');
  }),
);

// ── R3 供料缺口可见性 ────────────────────────────────────────────────────────
//
// 真实库曾 trigger 覆盖率为 0，通道接线正确但索引为空。前摄供料是**模型的自助动作**,
// 只有让缺口在工具输出里可见,模型才会去补。这组用例锁住那个可见性。

test(
  'R3 供料: memory_list 标出缺 trigger 的条件式条目,补齐后标记消失',
  isolated(async () => {
    assert.ok(saveEntry({ name: 'no-trigger-pitfall', summary: '缺 trigger 的坑', body: 'b', type: 'pitfall' }).ok);
    // fact 不要求 trigger,不该被标
    assert.ok(saveEntry({ name: 'plain-fact-2', summary: '普通事实', body: 'b', type: 'fact' }).ok);

    const before = String(await memoryListTool.execute({}));
    assert.match(before, /no-trigger-pitfall.*\[NO-TRIGGER\]/, 'pitfall 缺 trigger 应被标出');
    assert.doesNotMatch(before, /plain-fact-2.*\[NO-TRIGGER\]/, 'fact 不要求 trigger,不应被标');
    assert.match(before, /条条目缺 trigger/, '应给出汇总提示');

    assert.ok(updateEntry('no-trigger-pitfall', { trigger: '构造工具 schema 发给 dashscope 时' }).ok);
    const after = String(await memoryListTool.execute({}));
    assert.doesNotMatch(after, /\[NO-TRIGGER\]\n?- no-trigger-pitfall/, '补齐后该条不再被标');
    assert.ok(!after.includes('no-trigger-pitfall — 缺 trigger 的坑 (pitfall, active) [NO-TRIGGER]'));
  }),
);

test(
  'R3 供料: 补齐 trigger 后条目立刻进入前摄索引可被命中',
  isolated(() => {
    assert.ok(saveEntry({ name: 'gap-entry', summary: '转化前的坑', body: 'schema body', type: 'pitfall' }).ok);
    const ctx = '构造工具 schema 发给 dashscope compatible-mode 时 400';
    assert.equal(
      matchProactive('write_file', { path: 'src/llm/tool-schema.ts' }, ctx).length,
      0,
      '无 trigger 不进索引',
    );

    assert.ok(updateEntry('gap-entry', { trigger: '构造工具 schema 发给 dashscope compatible-mode 时' }).ok);
    const hits = matchProactive('write_file', { path: 'src/llm/tool-schema.ts' }, ctx).map((m) => m.entry.id);
    assert.ok(hits.includes('gap-entry'), '补齐 trigger 后应立刻可命中');
  }),
);
