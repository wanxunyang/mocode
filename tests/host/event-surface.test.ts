/**
 * host ⇄ 渲染层的事件面对齐测试。
 *
 * 为什么需要：这类 bug 全都**不报错**——host 发了事件，渲染层的 switch 没有对应
 * case，于是什么都不发生。已知踩过的三次：
 *   - `runtime_ready` 被整条丢弃 → MCP 启动警告与协议版本不匹配永远到不了用户眼前；
 *   - `ask_human` 从不发 approval_requested（只在 supervised 模式注入 handler）→ 静默选第一项；
 *   - 六个展示钩子（retry / live usage / 图片压缩 / 工具流式输出 / 无回复 / 最大步数）
 *     根本不转发 → 对应交互在 GUI 里不存在。
 *
 * 做法是源码级派生校验而不是手写清单：host 发出的事件名集合必须被渲染层的 case 覆盖，
 * 反过来渲染层也不该留永远收不到的 case。新增事件忘了接一侧，这里就红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest) && readFileSync(manifest, 'utf8').includes('"name": "mocode-ai"')) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（package.json 里 name=mocode-ai）');
}

const repoRoot = findRepoRoot();
const hostSource = readFileSync(path.join(repoRoot, 'src/host/stdio.ts'), 'utf8');
const rendererSource = readFileSync(path.join(repoRoot, 'packages/work-app/src/renderer/renderer.ts'), 'utf8');
/**
 * 面板回执事件（sessions_report / rollback_applied / …）不走 renderer 的 switch：
 * 它们是「命令 → 回执」配对的，按 requestId 在 panels.ts 的 PANEL_EVENTS 里认领，
 * 由 handlePanelEvent 先于任务事件流拦下。所以这里也要读那个文件。
 */
const panelsSource = readFileSync(path.join(repoRoot, 'packages/work-app/src/renderer/panels.ts'), 'utf8');

/** panels.ts 里 PANEL_EVENTS 集合列出的回执事件名。 */
function panelEvents(): Set<string> {
  const names = new Set<string>();
  const block = /const PANEL_EVENTS = new Set\(\[([\s\S]*?)\]\)/.exec(panelsSource);
  if (!block) return names;
  for (const match of block[1]!.matchAll(/'([a-z_]+)'/g)) names.add(match[1]!);
  return names;
}

/**
 * host 发出的事件名。两种写法：
 *   emit('name', ...)                       — 单行
 *   emit(\n  'name',                        — 多行（run_completed / approval_requested 这种）
 */
function hostEvents(): Set<string> {
  const names = new Set<string>();
  for (const match of hostSource.matchAll(/emit\(\s*'([a-z_]+)'/g)) names.add(match[1]!);
  return names;
}

/** 渲染层 switch(envelope.event) 里出现的 case 名。 */
function rendererCases(): Set<string> {
  const names = new Set<string>();
  for (const match of rendererSource.matchAll(/case '([a-z_]+)':/g)) names.add(match[1]!);
  return names;
}

test('host 发出的每个事件都有渲染层分支（否则静默失效）', () => {
  const emitted = hostEvents();
  assert.ok(emitted.size >= 18, `解析到的事件太少（${emitted.size}），测试本身可能失效`);
  const cases = rendererCases();
  // 无 requestId 的事件走全局通道，在 switch 之前单独分发，所以不是 case：
  // 它们必须在 handleHostLog / handleRuntimeReady 里有对应分支。
  const globalChannel = new Set(['host_log', 'runtime_ready']);
  for (const name of globalChannel) {
    if (!emitted.has(name)) continue;
    const handler = name === 'host_log' ? 'handleHostLog' : 'handleRuntimeReady';
    assert.ok(
      new RegExp(`envelope\\.event === '${name}'[\\s\\S]{0,80}${handler}\\(`).test(rendererSource),
      `全局通道事件 ${name} 必须在 handleAgentEvent 里分发到 ${handler}()`,
    );
  }
  // run_finished 与 run_completed 重复（只多带 elapsedMs），后者已覆盖轮末。
  // 面板回执走「命令 → 回执」配对通道（panels.ts 的 PANEL_EVENTS + handlePanelEvent），
  // 不是 switch 里的 case；它们由 handleAgentEvent 开头统一拦下。
  const panel = panelEvents();
  assert.ok(panel.size >= 4, `panels.ts 的 PANEL_EVENTS 解析失败（${panel.size}）`);
  assert.ok(
    /function handleAgentEvent[\s\S]{0,400}handlePanelEvent\(envelope\)/.test(rendererSource),
    'handleAgentEvent 必须先调 handlePanelEvent：面板回执落在任务分支里会把正在跑的任务误判为失败',
  );
  /**
   * 协议里有命令但 GUI 暂不接的事件。
   *
   * rollback_report / rollback_applied：回滚在 work-app 里**只回滚对话**，入口是用户消息气泡上
   * 的按钮，走主进程的 rollbackSession()（截断会话文件、不碰磁盘）。host 侧那套
   * changeset 回滚仍在协议里可用（终端 /rollback 相同实现），只是 GUI 没有对应入口，
   * 所以这两个回执没人认领。哪天 GUI 支持"勾选文件还原"，从 panels.ts 接回来即可。
   */
  const protocolOnly = new Set(['rollback_report', 'rollback_applied']);
  const allowedMissing = new Set(['run_finished', ...globalChannel, ...panel, ...protocolOnly]);
  const missing = [...emitted].filter((name) => !cases.has(name) && !allowedMissing.has(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `以下 host 事件在 packages/work-app/src/renderer/renderer.ts 里没有 case：\n${missing.join('\n')}\n` +
      '不接就等于该能力在 GUI 里不存在（无报错、无日志）。',
  );
});

test('panels.ts 认领的回执都有 host 侧 emit（不留空等）', () => {
  const emitted = hostEvents();
  const orphan = [...panelEvents()].filter((name) => !emitted.has(name)).sort();
  assert.deepEqual(orphan, [], `panels.ts 期望这些回执但 host 从不发：${orphan.join(', ')}`);
});

test('渲染层的每个 case 都是 host 真的会发的事件（不留死分支）', () => {
  const cases = rendererCases();
  const emitted = hostEvents();
  // 这些事件由渲染层或桌面主进程合成，不来自 host 的 emit：
  //   host_stopped / host_exit 由 main.ts（LocalAgent 的 onExit）产生；
  //   cheatsheet / search 是纯 UI 交互（快捷键面板、会话内搜索）。
  // host_log 同时存在于全局通道与 switch 内（运行期日志也带 requestId），两侧都合法。
  // attention_open 同样由主进程产生（packages/work-app/src/main.ts 的 notification.on('click')
  // → pushRenderer('work:agent-event')）：系统通知被点击时让渲染层跳到那个任务并摆出审批卡。
  // 它走的是同一条 onAgentEvent 通道，只是**没有** host 侧 emit —— 系统通知是 Electron 的能力，
  // host 是纯 stdio 进程，发不出也收不到通知点击。
  const locallySynthesized = new Set([
    'host_stopped',
    'host_exit',
    'cheatsheet',
    'search',
    'host_log',
    'attention_open',
    'run_changed_files',
  ]);
  const orphan = [...cases].filter((name) => !emitted.has(name) && !locallySynthesized.has(name)).sort();
  assert.deepEqual(orphan, [], `渲染层的这些 case 永远收不到 host 事件：${orphan.join(', ')}`);
});

test('ask_human 在非 supervised host 里也必须走审批通道', () => {
  // 曾经的 bug：setAskHumanHandler 只在 MOCODE_SUPERVISED_WORKER=1 时注入，
  // 普通 host 落到 promptIntervention；host 没有 layout，layout.isActive() 为 false，
  // 于是自动选第一项 —— 模型「问」了，用户从没看见，却已经被答复。
  const supervisedGuard = /if \(process\.env\.MOCODE_SUPERVISED_WORKER === '1'\) \{\s*setAskHumanHandler/;
  assert.ok(
    !supervisedGuard.test(hostSource),
    'setAskHumanHandler 不能只在 supervised 模式下注入：普通 host 的 ask_human 会静默选第一项',
  );
  assert.ok(/setAskHumanHandler\(/.test(hostSource), 'host 必须注入 ask_human 处理器');
});
