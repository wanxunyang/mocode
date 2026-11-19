import type { ShortPathTask } from './types.js';

/**
 * S4 repo:self-host 真实仓库层。
 *
 * 任务直接落在 mocode 自己的代码上:runner 先把 `git archive HEAD` 解包到临时目录,
 * junction 共享主仓库 node_modules(tsx/ajv 等零安装可用),再把 verifier 脚本写进快照,
 * agent 在快照里改真实源码,verifier 用 tsx 直接 import 修改后的 TS 模块做运行时断言。
 *
 * 题目全部是「新增导出函数」式的增量任务:不改动既有行为、目标模块都是纯叶子模块
 * (无 LLM/网络/UI 依赖),仓库演进导致题目失效时会在 verifier 上直接暴露(判失败),
 * 届时重新校准题目并 --update-baseline 即可。
 *
 * 上下文现实:快照里有完整的 AGENTS.md / src 结构,agent 会不会利用 AGENTS.md 的
 * 目录指引直奔目标文件,正是这一层要测的短路径能力。gold 路径 = 定位文件 read → edit
 * (→ 可选 verifier),maxToolCalls = 6(比合成仓库宽松:真实仓库哪怕直奔目标也至少要
 * 读一次目标文件)。
 */

const REPO_VERIFY_TIMEOUT_MS = 60_000;
const REPO_AGENT_TIMEOUT_MS = 300_000;

export const repoTasks: ShortPathTask[] = [
  {
    id: 'repo-01',
    title: 'hash.ts 新增 shortContentHash',
    scenario: 'repo',
    level: 5,
    goal: `在 src/changeset/hash.ts 新增导出函数 shortContentHash(content: Buffer | string, length = 8): string,
返回 contentHash 结果去掉 "sha256:" 前缀后的前 length 位十六进制。不得改动 contentHash / normalizeContentHash 的既有行为。
完成后运行 node node_modules/tsx/dist/cli.mjs scripts/verify-repo-01.mjs 自查(在仓库根目录)。`,
    files: [
      {
        path: 'scripts/verify-repo-01.mjs',
        content: `import assert from 'node:assert/strict';
import { contentHash, shortContentHash } from '../src/changeset/hash.js';
const full = contentHash('abc');
assert.equal(shortContentHash('abc'), full.slice('sha256:'.length, 'sha256:'.length + 8));
assert.equal(shortContentHash('abc', 12), full.slice('sha256:'.length, 'sha256:'.length + 12));
assert.equal(shortContentHash('abc').length, 8);
assert.equal(shortContentHash(Buffer.from('abc')), full.slice('sha256:'.length, 'sha256:'.length + 8));
console.log('ok');
`,
      },
    ],
    repoSnapshot: true,
    verificationCommand: 'node node_modules/tsx/dist/cli.mjs scripts/verify-repo-01.mjs',
    verifyTimeoutMs: REPO_VERIFY_TIMEOUT_MS,
    timeoutMs: REPO_AGENT_TIMEOUT_MS,
    gold: { maxToolCalls: 6, maxRequestsBeforeFirstEdit: 3 },
    expected: { files: ['src/changeset/hash.ts'] },
  },
  {
    id: 'repo-02',
    title: 'unified-diff.ts 新增 unifiedDiffStats',
    scenario: 'repo',
    level: 5,
    goal: `在 src/changeset/unified-diff.ts 新增导出函数 unifiedDiffStats(diff: string): { added: number; removed: number }。
统计 diff 正文中以 "+" 开头的行数(added)与以 "-" 开头的行数(removed);diff 头(--- / +++)与 @@ hunk 头不计入。
不得改动 unifiedFileDiff 的既有行为。完成后运行 node node_modules/tsx/dist/cli.mjs scripts/verify-repo-02.mjs 自查。`,
    files: [
      {
        path: 'scripts/verify-repo-02.mjs',
        content: `import assert from 'node:assert/strict';
import { unifiedDiffStats, unifiedFileDiff } from '../src/changeset/unified-diff.js';

const diff = unifiedFileDiff('demo.txt', 'a\\nb\\nc', 'aX\\nc');
const stats = unifiedDiffStats(diff);
assert.equal(stats.added, 1, \`added should be 1, got \${stats.added}\`);
assert.equal(stats.removed, 2, \`removed should be 2, got \${stats.removed}\`);
assert.deepEqual(unifiedDiffStats(''), { added: 0, removed: 0 });

const created = unifiedFileDiff('new.txt', null, 'one\\ntwo');
const createdStats = unifiedDiffStats(created);
assert.equal(createdStats.added, 2);
assert.equal(createdStats.removed, 0);
console.log('ok');
`,
      },
    ],
    repoSnapshot: true,
    verificationCommand: 'node node_modules/tsx/dist/cli.mjs scripts/verify-repo-02.mjs',
    verifyTimeoutMs: REPO_VERIFY_TIMEOUT_MS,
    timeoutMs: REPO_AGENT_TIMEOUT_MS,
    gold: { maxToolCalls: 6, maxRequestsBeforeFirstEdit: 3 },
    expected: { files: ['src/changeset/unified-diff.ts'] },
  },
  {
    id: 'repo-03',
    title: 'result.ts 新增 toolErrorReason',
    scenario: 'repo',
    level: 5,
    goal: `在 src/tools/result.ts 新增导出函数 toolErrorReason(output: string): string | null。
当 isToolErrorOutput(output) 为真时,返回去掉行首 "错误:" 或 "Error:" 前缀并 trim 后的首行;否则返回 null。
不得改动 isToolErrorOutput 的既有行为。完成后运行 node node_modules/tsx/dist/cli.mjs scripts/verify-repo-03.mjs 自查。`,
    files: [
      {
        path: 'scripts/verify-repo-03.mjs',
        content: `import assert from 'node:assert/strict';
import { isToolErrorOutput, toolErrorReason } from '../src/tools/result.js';
assert.equal(toolErrorReason('错误:文件不存在'), '文件不存在');
assert.equal(toolErrorReason('Error: boom'), 'boom');
assert.equal(toolErrorReason('  Error: padded'), 'padded');
assert.equal(toolErrorReason('plain output'), null);
assert.equal(toolErrorReason(''), null);
assert.equal(isToolErrorOutput('Error: x'), true, 'existing behavior must not change');
console.log('ok');
`,
      },
    ],
    repoSnapshot: true,
    verificationCommand: 'node node_modules/tsx/dist/cli.mjs scripts/verify-repo-03.mjs',
    verifyTimeoutMs: REPO_VERIFY_TIMEOUT_MS,
    timeoutMs: REPO_AGENT_TIMEOUT_MS,
    gold: { maxToolCalls: 6, maxRequestsBeforeFirstEdit: 3 },
    expected: { files: ['src/tools/result.ts'] },
  },
  {
    id: 'repo-04',
    title: 'trace-sanitize.ts 新增 sameToolCall',
    scenario: 'repo',
    level: 5,
    goal: `在 src/session/trace-sanitize.ts 新增导出函数 sameToolCall(a: SafeArgumentSummary, b: SafeArgumentSummary): boolean。
两个参数摘要在 sha256 指纹相同时返回 true(即工具参数完全一致),否则 false。该函数用于后续的冗余工具调用检测。
不得改动既有导出的行为。完成后运行 node node_modules/tsx/dist/cli.mjs scripts/verify-repo-04.mjs 自查。`,
    files: [
      {
        path: 'scripts/verify-repo-04.mjs',
        content: `import assert from 'node:assert/strict';
import { sameToolCall, summarizeToolArguments } from '../src/session/trace-sanitize.js';
const a = summarizeToolArguments(JSON.stringify({ path: 'src/a.ts' }));
const b = summarizeToolArguments(JSON.stringify({ path: 'src/a.ts' }));
const c = summarizeToolArguments(JSON.stringify({ path: 'src/b.ts' }));
assert.equal(sameToolCall(a, b), true);
assert.equal(sameToolCall(a, c), false);
assert.equal(sameToolCall(a, a), true);
console.log('ok');
`,
      },
    ],
    repoSnapshot: true,
    verificationCommand: 'node node_modules/tsx/dist/cli.mjs scripts/verify-repo-04.mjs',
    verifyTimeoutMs: REPO_VERIFY_TIMEOUT_MS,
    timeoutMs: REPO_AGENT_TIMEOUT_MS,
    gold: { maxToolCalls: 6, maxRequestsBeforeFirstEdit: 3 },
    expected: { files: ['src/session/trace-sanitize.ts'] },
  },
  {
    id: 'repo-05',
    title: 'dir-snapshot.ts 新增 snapshotStats',
    scenario: 'repo',
    level: 5,
    goal: `在 src/jobs/dir-snapshot.ts 新增导出函数 snapshotStats(diff: SnapshotDiff): { added: number; removed: number; modified: number }。
返回三类变更的计数。不得改动 diffSnapshots / diffRoots 的既有行为。
完成后运行 node node_modules/tsx/dist/cli.mjs scripts/verify-repo-05.mjs 自查。`,
    files: [
      {
        path: 'scripts/verify-repo-05.mjs',
        content: `import assert from 'node:assert/strict';
import { diffSnapshots, snapshotStats } from '../src/jobs/dir-snapshot.js';

const snapshot = (entries) => ({ version: 1, root: '/tmp/demo', createdAt: '2026-01-01T00:00:00Z', entries });
const before = snapshot({ 'a.txt': { size: 1, mtimeMs: 1 }, 'b.txt': { size: 2, mtimeMs: 2 } });
const after = snapshot({ 'a.txt': { size: 9, mtimeMs: 9 }, 'c.txt': { size: 3, mtimeMs: 3 } });
const stats = snapshotStats(diffSnapshots(before, after));
assert.deepEqual(stats, { added: 1, removed: 1, modified: 1 });
assert.deepEqual(snapshotStats(diffSnapshots(snapshot({}), snapshot({}))), { added: 0, removed: 0, modified: 0 });
console.log('ok');
`,
      },
    ],
    repoSnapshot: true,
    verificationCommand: 'node node_modules/tsx/dist/cli.mjs scripts/verify-repo-05.mjs',
    verifyTimeoutMs: REPO_VERIFY_TIMEOUT_MS,
    timeoutMs: REPO_AGENT_TIMEOUT_MS,
    gold: { maxToolCalls: 6, maxRequestsBeforeFirstEdit: 3 },
    expected: { files: ['src/jobs/dir-snapshot.ts'] },
  },
  {
    id: 'repo-06',
    title: 'request-limit.ts 新增 fitsRequestBudget',
    scenario: 'repo',
    level: 5,
    goal: `在 src/context/request-limit.ts 新增导出函数 fitsRequestBudget(messages, tools = [], budgetBytes): boolean,
当 estimateRequestBytes(messages, tools) 不超过 budgetBytes 时返回 true。不得改动 estimateRequestBytes 的既有行为。
完成后运行 node node_modules/tsx/dist/cli.mjs scripts/verify-repo-06.mjs 自查。`,
    files: [
      {
        path: 'scripts/verify-repo-06.mjs',
        content: `import assert from 'node:assert/strict';
import { estimateRequestBytes, fitsRequestBudget } from '../src/context/request-limit.js';
const messages = [{ role: 'user', content: 'hello' }];
const bytes = estimateRequestBytes(messages, []);
assert.ok(bytes > 0, 'estimateRequestBytes must be positive for a non-empty message');
assert.equal(fitsRequestBudget(messages, [], bytes), true);
assert.equal(fitsRequestBudget(messages, [], bytes - 1), false);
console.log('ok');
`,
      },
    ],
    repoSnapshot: true,
    verificationCommand: 'node node_modules/tsx/dist/cli.mjs scripts/verify-repo-06.mjs',
    verifyTimeoutMs: REPO_VERIFY_TIMEOUT_MS,
    timeoutMs: REPO_AGENT_TIMEOUT_MS,
    gold: { maxToolCalls: 6, maxRequestsBeforeFirstEdit: 3 },
    expected: { files: ['src/context/request-limit.ts'] },
  },
  {
    id: 'repo-07',
    title: 'i18n 新增 isSupportedLanguage',
    scenario: 'repo',
    level: 5,
    goal: `在 src/i18n/index.ts 新增导出函数 isSupportedLanguage(value?: string | null): boolean,
等价于 normalizeLanguage(value) !== null 的谓词形式('zh'/'zh-CN'/'en'/'en_US' 等支持,'fr'/''/null 不支持)。
不得改动 normalizeLanguage 的既有行为。完成后运行 node node_modules/tsx/dist/cli.mjs scripts/verify-repo-07.mjs 自查。`,
    files: [
      {
        path: 'scripts/verify-repo-07.mjs',
        content: `import assert from 'node:assert/strict';
import { isSupportedLanguage, normalizeLanguage } from '../src/i18n/index.js';
assert.equal(isSupportedLanguage('zh'), true);
assert.equal(isSupportedLanguage('en-US'), true);
assert.equal(isSupportedLanguage('zh_CN'), true);
assert.equal(isSupportedLanguage('fr'), false);
assert.equal(isSupportedLanguage(''), false);
assert.equal(isSupportedLanguage(null), false);
assert.equal(isSupportedLanguage('zh'), normalizeLanguage('zh') !== null, 'must stay consistent with normalizeLanguage');
console.log('ok');
`,
      },
    ],
    repoSnapshot: true,
    verificationCommand: 'node node_modules/tsx/dist/cli.mjs scripts/verify-repo-07.mjs',
    verifyTimeoutMs: REPO_VERIFY_TIMEOUT_MS,
    timeoutMs: REPO_AGENT_TIMEOUT_MS,
    gold: { maxToolCalls: 6, maxRequestsBeforeFirstEdit: 3 },
    expected: { files: ['src/i18n/index.ts'] },
  },
  {
    id: 'repo-08',
    title: 'image.ts 新增 mimeFromExtension',
    scenario: 'repo',
    level: 5,
    goal: `在 src/attachments/image.ts 新增导出函数 mimeFromExtension(filename: string): ImageMime | null。
按扩展名返回 MIME:png → image/png;jpg/jpeg → image/jpeg;gif → image/gif;webp → image/webp;大小写不敏感;其余(含无扩展名)返回 null。
不得改动 sniffImageMime 等既有函数。完成后运行 node node_modules/tsx/dist/cli.mjs scripts/verify-repo-08.mjs 自查。`,
    files: [
      {
        path: 'scripts/verify-repo-08.mjs',
        content: `import assert from 'node:assert/strict';
import { mimeFromExtension } from '../src/attachments/image.js';
assert.equal(mimeFromExtension('shot.png'), 'image/png');
assert.equal(mimeFromExtension('PHOTO.JPG'), 'image/jpeg');
assert.equal(mimeFromExtension('a.jpeg'), 'image/jpeg');
assert.equal(mimeFromExtension('anim.gif'), 'image/gif');
assert.equal(mimeFromExtension('pic.webp'), 'image/webp');
assert.equal(mimeFromExtension('file.txt'), null);
assert.equal(mimeFromExtension('noext'), null);
console.log('ok');
`,
      },
    ],
    repoSnapshot: true,
    verificationCommand: 'node node_modules/tsx/dist/cli.mjs scripts/verify-repo-08.mjs',
    verifyTimeoutMs: REPO_VERIFY_TIMEOUT_MS,
    timeoutMs: REPO_AGENT_TIMEOUT_MS,
    gold: { maxToolCalls: 6, maxRequestsBeforeFirstEdit: 3 },
    expected: { files: ['src/attachments/image.ts'] },
  },
  {
    id: 'repo-09',
    title: 'llm 新增 isMostlyCjk',
    scenario: 'repo',
    level: 5,
    goal: `在 src/llm/index.ts 新增导出函数 isMostlyCjk(text: string, ratio = 0.3): boolean。
统计文本中 CJK 字符的占比(模块内已有 isCJK 判定可复用),占比 >= ratio 时返回 true;空串返回 false。
不得改动 estimateTokens 等既有函数。完成后运行 node node_modules/tsx/dist/cli.mjs scripts/verify-repo-09.mjs 自查。`,
    files: [
      {
        path: 'scripts/verify-repo-09.mjs',
        content: `import assert from 'node:assert/strict';
import { estimateTokens, isMostlyCjk } from '../src/llm/index.js';
assert.equal(isMostlyCjk('这是一段中文文本'), true);
assert.equal(isMostlyCjk('hello world'), false);
assert.equal(isMostlyCjk(''), false);
assert.equal(isMostlyCjk('abc中'), false, '1/4 CJK is below the default ratio');
assert.equal(isMostlyCjk('abc中', 0.2), true, '1/4 CJK passes a lower ratio');
assert.equal(typeof estimateTokens('测试'), 'number', 'estimateTokens must stay intact');
console.log('ok');
`,
      },
    ],
    repoSnapshot: true,
    verificationCommand: 'node node_modules/tsx/dist/cli.mjs scripts/verify-repo-09.mjs',
    verifyTimeoutMs: REPO_VERIFY_TIMEOUT_MS,
    timeoutMs: REPO_AGENT_TIMEOUT_MS,
    gold: { maxToolCalls: 6, maxRequestsBeforeFirstEdit: 3 },
    expected: { files: ['src/llm/index.ts'] },
  },
  {
    id: 'repo-10',
    title: 'catalog.ts 新增 snapshotAgeHours',
    scenario: 'repo',
    level: 5,
    goal: `在 src/models/catalog.ts 新增导出函数 snapshotAgeHours(snapshot: CatalogSnapshot, now: Date = new Date()): number。
返回快照年龄(小时,(now - fetchedAt) / 3600000);fetchedAt 无法解析时返回 -1。不得改动 isFresh 的既有行为。
完成后运行 node node_modules/tsx/dist/cli.mjs scripts/verify-repo-10.mjs 自查。`,
    files: [
      {
        path: 'scripts/verify-repo-10.mjs',
        content: `import assert from 'node:assert/strict';
import { snapshotAgeHours } from '../src/models/catalog.js';
const at = (iso) => ({ fetchedAt: iso });
const now = new Date('2026-01-02T12:00:00Z');
assert.equal(snapshotAgeHours(at('2026-01-02T00:00:00Z'), now), 12);
assert.equal(snapshotAgeHours(at('2026-01-01T00:00:00Z'), now), 36);
assert.equal(snapshotAgeHours(at('not-a-date'), now), -1);
console.log('ok');
`,
      },
    ],
    repoSnapshot: true,
    verificationCommand: 'node node_modules/tsx/dist/cli.mjs scripts/verify-repo-10.mjs',
    verifyTimeoutMs: REPO_VERIFY_TIMEOUT_MS,
    timeoutMs: REPO_AGENT_TIMEOUT_MS,
    gold: { maxToolCalls: 6, maxRequestsBeforeFirstEdit: 3 },
    expected: { files: ['src/models/catalog.ts'] },
  },
  {
    id: 'repo-11',
    title: 'permissions 新增 hasRisk',
    scenario: 'repo',
    level: 5,
    goal: `在 src/permissions/index.ts 新增导出函数 hasRisk(tool: Tool): boolean,
当 getToolRisk(tool) 不是 'safe' 时返回 true。不得改动 getToolRisk 的既有行为。
完成后运行 node node_modules/tsx/dist/cli.mjs scripts/verify-repo-11.mjs 自查。`,
    files: [
      {
        path: 'scripts/verify-repo-11.mjs',
        content: `import assert from 'node:assert/strict';
import { hasRisk } from '../src/permissions/index.js';
const tool = (risk) => ({ name: 'demo', risk });
assert.equal(hasRisk(tool('safe')), false);
assert.equal(hasRisk(tool('medium')), true);
assert.equal(hasRisk({ name: 'no-risk-field' }), false, 'missing risk defaults to safe');
console.log('ok');
`,
      },
    ],
    repoSnapshot: true,
    verificationCommand: 'node node_modules/tsx/dist/cli.mjs scripts/verify-repo-11.mjs',
    verifyTimeoutMs: REPO_VERIFY_TIMEOUT_MS,
    timeoutMs: REPO_AGENT_TIMEOUT_MS,
    gold: { maxToolCalls: 6, maxRequestsBeforeFirstEdit: 3 },
    expected: { files: ['src/permissions/index.ts'] },
  },
  {
    id: 'repo-12',
    title: 'command.ts 新增 isSensitiveEnvKey',
    scenario: 'repo',
    level: 5,
    goal: `在 src/sandbox/command.ts 新增导出函数 isSensitiveEnvKey(key: string): boolean,
当 key 命中模块内的 ENV_DENY 正则(*_KEY / *TOKEN / *SECRET / *CREDENTIAL / *PASSWORD / LLM_*)时返回 true。
不得改动 filterEnv / isCommandDenied 的既有行为。完成后运行 node node_modules/tsx/dist/cli.mjs scripts/verify-repo-12.mjs 自查。`,
    files: [
      {
        path: 'scripts/verify-repo-12.mjs',
        content: `import assert from 'node:assert/strict';
import { filterEnv, isSensitiveEnvKey } from '../src/sandbox/command.js';
assert.equal(isSensitiveEnvKey('LLM_API_KEY'), true);
assert.equal(isSensitiveEnvKey('ANY_TOKEN'), true);
assert.equal(isSensitiveEnvKey('DB_SECRET'), true);
assert.equal(isSensitiveEnvKey('MY_PASSWORD'), true);
assert.equal(isSensitiveEnvKey('PATH'), false);
assert.equal(isSensitiveEnvKey('HOME'), false);
const filtered = filterEnv({ PATH: '/bin', LLM_API_KEY: 'x' });
assert.equal('LLM_API_KEY' in filtered, false, 'filterEnv behavior must not change');
assert.equal(filtered.PATH, '/bin');
console.log('ok');
`,
      },
    ],
    repoSnapshot: true,
    verificationCommand: 'node node_modules/tsx/dist/cli.mjs scripts/verify-repo-12.mjs',
    verifyTimeoutMs: REPO_VERIFY_TIMEOUT_MS,
    timeoutMs: REPO_AGENT_TIMEOUT_MS,
    gold: { maxToolCalls: 6, maxRequestsBeforeFirstEdit: 3 },
    expected: { files: ['src/sandbox/command.ts'] },
  },
];
