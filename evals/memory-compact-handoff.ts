// R13 压缩→记忆交接 真实验收:npm run eval:memory-handoff
//
// 为什么它不在 tests/ 里:npm test 必须离线、确定、秒级;而这条通道的验收**只能**
// 用真实模型——候选段是模型按提示词顺带产出的,桩测试只能证明"有候选段时会怎么处理",
// 证明不了"模型真的会产出候选",也证明不了"没货时它不会凑数"。
//
// 三个场景:
//   A 正向(有货)  用户硬约束 + 一条走过弯路的死路 + 一条带理由的决策 → 应有候选,反思应消费
//   B 开关关闭    同一段上下文,MOCODE_MEMORY_COMPACT_HANDOFF=0 → 候选段仍被切走,但队列为空
//   C 反向(无货)  只读文件 + 跑一次全过的测试 → 不应产出候选(原设计最担心的凑数)
//
// 结构不变量是硬失败(摘要残留候选段、开关失效、队列没被消费),内容依赖的判断
// (A 是否产出候选)允许重试一次——LLM 有随机性,偶发空段不该判红;但两次都空就是
// 提示词回归,这是这个脚本存在的理由。
//
// 隔离:临时 HOME + 临时 cwd,动态 import 前设好 env。绝不读写真实 ~/.mocode 记忆库。
// 无 LLM 配置时打印 skip 并 exit 0(CI 无密钥不该失败)。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/** 读真实用户的 mocode 配置(必须在改 HOME 之前,否则读不到)。 */
function readMcConfig(): Record<string, string> {
  const out: Record<string, string> = {};
  const candidates = [path.join(os.homedir(), '.mocode', 'config'), path.join(process.cwd(), '.mocode', 'config')];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    } catch {
      /* 读不到就跳过:下面会按缺失处理 */
    }
  }
  return out;
}

const realCfg = readMcConfig();
const baseURL = process.env.LLM_BASE_URL ?? realCfg.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY ?? realCfg.LLM_API_KEY;
const model = process.env.LLM_MODEL ?? realCfg.LLM_MODEL;
if (!baseURL || !apiKey || !model) {
  console.log('skip: 没有 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL(环境变量或 ~/.mocode/config)');
  process.exit(0);
}

// 隔离:临时 HOME(global scope)+ 临时根(project scope)
const root = mkdtempSync(path.join(os.tmpdir(), 'mocode-eval-handoff-'));
const home = path.join(root, 'home');
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows 上 os.homedir() 优先取 USERPROFILE
process.env.LLM_BASE_URL = baseURL;
process.env.LLM_API_KEY = apiKey;
process.env.LLM_MODEL = model;
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER ?? realCfg.LLM_PROVIDER ?? 'openai';
process.env.MEMORY_ENABLED = 'true';
delete process.env.MOCODE_MEMORY_COMPACT_HANDOFF;
console.log(`[env] model=${model} | isolated=${root}\n`);

const compactMod = await import('../src/session/compact.js');
const pendingMod = await import('../src/memory/pending.js');
const reflectMod = await import('../src/memory/reflect.js');
const llmMod = await import('../src/llm/index.js');
const configMod = await import('../src/config/index.js');

type Msg = Parameters<typeof compactMod.compactHistory>[0][number];

/** 切换到场景专属 cwd:记忆库与 pending 队列都按 cwd 定位,天然互不干扰。 */
function intoScenario(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  process.chdir(dir);
  return dir;
}

interface RunResult {
  /** 压缩器最后一次原始输出(用来判断模型到底有没有写候选段)。 */
  raw: string;
  /** 存进 history 的摘要正文。 */
  summary: string;
  /** 本次压缩后队列里的候选。 */
  queued: ReturnType<typeof pendingMod.loadPendingCandidates>;
  calls: number;
}

async function runCompaction(history: Msg[]): Promise<RunResult> {
  const raws: string[] = [];
  let calls = 0;
  const wrapped = async (
    messages: Parameters<typeof llmMod.chat>[0],
    handlers: Parameters<typeof llmMod.chat>[1],
    signal: Parameters<typeof llmMod.chat>[2],
    tools: Parameters<typeof llmMod.chat>[3],
    opts: Parameters<typeof llmMod.chat>[4],
  ) => {
    calls++;
    const r = await llmMod.chat(messages, handlers, signal, tools, opts);
    raws.push(r.content ?? '');
    return r;
  };
  await compactMod.compactHistory(history, {
    window: 4000,
    threshold: 0,
    tools: [],
    contextState: compactMod.contextState, // 主 agent 状态 = 入队前提
    runtime: { config: configMod.config, modelTransport: wrapped },
  });
  const sys = history.find((m) => m.role === 'system' && String(m.content).startsWith('# 会话摘要'));
  return {
    raw: raws[raws.length - 1] ?? '',
    summary: sys ? String(sys.content) : '',
    queued: pendingMod.loadPendingCandidates(),
    calls,
  };
}

// ── 会话构造 ────────────────────────────────────────────────────────────────

const CONSTRAINT = '用户约束:这套服务的所有 Redis 写操作必须带 TTL,不接受无过期键。';
const DEADEND =
  '我先假设缓存不一致是旧值没删干净,于是试了 FLUSHALL 全量清空、又试了把 key 前缀改成 v2 强制失效,两次都复现不了修复效果。' +
  '真正原因是 deploy 后连接池复用了旧连接,读到了还没 apply 的副本;换掉连接池的 minIdle 并加一次主动 PING 校验后才稳定。这个方向错掉了将近四十分钟。';
const DECISION =
  '决策:缓存层不再做"写后删除",改为写路径直接覆盖(写穿)。理由是删除在两副本窗口里会读到旧值,而覆盖是幂等的;代价是写放大,团队接受。';

let idc = 0;
function call(name: string, args: unknown): Msg {
  const id = `call_${++idc}`;
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } as unknown as Msg;
}
function toolResult(content: string): Msg {
  return { role: 'tool', tool_call_id: `call_${idc}`, content } as unknown as Msg;
}
const filler = (label: string): string =>
  `${label}\n` + 'function handleRequest(req) { return cache.get(req.key); }\n'.repeat(60);

function richHistory(): Msg[] {
  const h: Msg[] = [{ role: 'system', content: 'current system prompt' } as unknown as Msg];
  h.push({ role: 'user', content: CONSTRAINT } as unknown as Msg);
  h.push({ role: 'assistant', content: DEADEND } as unknown as Msg);
  h.push({ role: 'assistant', content: DECISION } as unknown as Msg);
  for (let i = 0; i < 4; i++) {
    h.push(call('read_file', { path: `src/cache/layer-${i}.ts` }));
    h.push(toolResult(filler(`// src/cache/layer-${i}.ts`)));
  }
  h.push({ role: 'user', content: 'continue' } as unknown as Msg);
  h.push(call('run_command', { command: 'npm test -- cache' }));
  h.push(toolResult('ok, 12 passed'));
  return h;
}

function trivialHistory(): Msg[] {
  const h: Msg[] = [{ role: 'system', content: 'current system prompt' } as unknown as Msg];
  h.push({ role: 'user', content: '看看 src/ui 下有哪些文件,顺便跑一下测试' } as unknown as Msg);
  for (let i = 0; i < 3; i++) {
    h.push(call('read_file', { path: `src/ui/view-${i}.ts` }));
    h.push(toolResult(`// src/ui/view-${i}.ts\n` + 'export const x = 1;\n'.repeat(120)));
  }
  h.push({ role: 'user', content: '好,继续' } as unknown as Msg);
  h.push(call('run_command', { command: 'npm test' }));
  h.push(toolResult('ok, 985 passed'));
  return h;
}

// ── A 正向:应有候选,反思应消费 ─────────────────────────────────────────────

console.log('A 正向(有货):硬约束 + 死路 + 决策');
intoScenario('a');
let a = await runCompaction(richHistory());
if (a.queued.length === 0) {
  // 允许一次重试:LLM 偶发空段不该判红;两次都空才是提示词回归。
  console.log('  … 本次无候选,重试一次');
  intoScenario('a-retry');
  a = await runCompaction(richHistory());
}
check('压缩器确实产出了候选段', /^ {0,3}##\s+memory\s+candidates/im.test(a.raw), a.raw.slice(-200));
check('候选已入队', a.queued.length > 0, `queued=${a.queued.length}`);
check(
  '存进 history 的摘要里没有候选段(先切后封顶)',
  a.summary.length > 0 && !/^ {0,3}##\s+memory\s+candidates/im.test(a.summary),
  a.summary.slice(-200),
);
check('候选条数不超过单次上限 3', a.queued.length <= 3, `queued=${a.queued.length}`);
console.log(`  候选 ${a.queued.length} 条:`);
for (const c of a.queued) console.log(`    - [${c.kind}] ${c.text.slice(0, 100)}`);

if (a.queued.length > 0) {
  const transcript = [
    `user: ${CONSTRAINT}`,
    `assistant: ${DECISION}`,
    `assistant: ${DEADEND}`,
    'user: continue 把缓存层改完',
  ].join('\n');
  const refl = await reflectMod.runReflection(transcript);
  console.log(`  反思: ${JSON.stringify({ saves: refl.saves, updates: refl.updates, error: refl.error })}`);
  check('反思无错误', refl.error === undefined, refl.error);
  check('反思消费了候选', refl.pendingConsumed === a.queued.length, `consumed=${refl.pendingConsumed}`);
  check('消费后队列清空', pendingMod.pendingCandidateCount() === 0, `left=${pendingMod.pendingCandidateCount()}`);
  check('至少落一条记忆', refl.saves > 0, `saves=${refl.saves}`);
}

// ── B 开关关闭:切走但不入队 ────────────────────────────────────────────────

console.log('\nB 开关关闭(MOCODE_MEMORY_COMPACT_HANDOFF=0)');
intoScenario('b');
process.env.MOCODE_MEMORY_COMPACT_HANDOFF = '0';
const b = await runCompaction(richHistory());
delete process.env.MOCODE_MEMORY_COMPACT_HANDOFF;
check('开关关闭时队列为空', b.queued.length === 0, `queued=${b.queued.length}`);
check('开关关闭时摘要仍不含候选段', !/^ {0,3}##\s+memory\s+candidates/im.test(b.summary), b.summary.slice(-200));

// ── C 反向:不该凑数 ────────────────────────────────────────────────────────

console.log('\nC 反向(无货):只读文件 + 跑测试');
intoScenario('c');
const c = await runCompaction(trivialHistory());
check('无货时不产出候选段', !/^ {0,3}##\s+memory\s+candidates/im.test(c.raw), c.raw.slice(-300));
check('无货时队列为空', c.queued.length === 0, `queued=${c.queued.length}`);

// ── 收尾 ────────────────────────────────────────────────────────────────────

process.chdir(os.tmpdir()); // 先离开,否则 Windows 上 rmSync 报 EBUSY
rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
