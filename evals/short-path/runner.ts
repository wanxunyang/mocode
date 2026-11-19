import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRuntime } from '../../src/runtime/index.js';
// 装配官方默认工具包:registry 不顶层 import builtins(破模块循环),eval runner 须显式装配。
import '../../src/tools/builtins/index.js';
import { config, getRouterMode, isToolRoutingEnabled } from '../../src/config/index.js';
import type { AgentRuntimeContext } from '../../src/agent/runtime-context.js';
import type { ChatMessage } from '../../src/llm/index.js';
import type { AgentTraceEvent } from '../../src/session/trace.js';
import { countReadOnlyCalls, reduceShortPathEfficiency } from '../../src/session/short-path-metrics.js';
import { clearSkillActivation } from '../../src/skills/activation.js';
import type { Tool } from '../../src/tools/types.js';
import { locateTasks } from './fixtures-locate.js';
import { CODING_EVAL_SESSION_ID, assembleCodingEvalTurn, buildCodingEvalSystemPrompt } from '../coding/runtime.js';
import {
  compareShortPathPreflight,
  compareShortPathReport,
  createRecordedShortPathBaseline,
  readShortPathBaseline,
  renderShortPathComparison,
  writeShortPathBaseline,
  type ShortPathBaseline,
} from './baseline.js';
import { selectByLevel, selectShortPathTasks, selectionScenario, shortPathTasks } from './fixtures.js';
import { createReport, renderSummary, writeReport } from './report.js';
import type { ShortPathReport, ShortPathScenario, ShortPathTask, ShortPathTaskResult } from './types.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 15_000;
const RUN_PREFIX = 'mocode-shortpath-';

export interface ShortPathCliOptions {
  selection: string;
  selectionSource: 'task' | 'group' | 'positional' | 'level' | null;
  /** --level N:按复杂度等级选题(L1-L5);与 --task/--group 互斥,优先级低于前者。 */
  level?: number;
  outDir: string;
  /** 空 = 按场景自动解析为 evals/short-path/baseline-<scenario>.json;显式 --baseline 时用原值。 */
  baselinePath: string;
  updateBaseline: boolean;
  efficiencyGate: boolean;
  list: boolean;
  keep: boolean;
  withoutGrepEditContext?: true;
  timeoutMs?: number;
}

/** 基线是 per-运行组的:单文件会被下一次 --update-baseline 覆盖,所以按组 key 分文件。
 *  key = --group 名(micro/hinted/warm/repo/l6)或 level 运行的 l<N>;--task 运行传 scenario。 */
export function resolveBaselinePath(baselinePath: string, key: string): string {
  if (baselinePath) return path.resolve(baselinePath);
  return path.resolve('evals/short-path', `baseline-${key}.json`);
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseShortPathArgs(args: string[]): ShortPathCliOptions {
  let taskSelection = '';
  let groupSelection = '';
  let positionalSelection = '';
  let outDir = 'evals/results/short-path';
  let baselinePath = '';
  let updateBaseline = false;
  let efficiencyGate = false;
  let list = false;
  let keep = false;
  let withoutGrepEditContext: true | undefined;
  let timeoutMs: number | undefined;
  let level: number | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--task') taskSelection = requiredValue(args, index++, arg);
    else if (arg === '--group') groupSelection = requiredValue(args, index++, arg);
    else if (arg === '--level') {
      const raw = requiredValue(args, index++, arg);
      level = Number(raw);
      if (!Number.isInteger(level) || level < 1 || level > 10) {
        throw new Error('--level must be an integer between 1 and 10 (covered: 1-5)');
      }
    } else if (arg === '--out') outDir = requiredValue(args, index++, arg);
    else if (arg === '--baseline') baselinePath = requiredValue(args, index++, arg);
    else if (arg === '--timeout') {
      const raw = requiredValue(args, index++, arg);
      timeoutMs = Number(raw);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('--timeout must be a positive number of milliseconds');
      }
    } else if (arg === '--update-baseline') updateBaseline = true;
    else if (arg === '--efficiency-gate') efficiencyGate = true;
    else if (arg === '--list') list = true;
    else if (arg === '--keep-workspaces') keep = true;
    else if (arg === '--without-grep-edit-context') withoutGrepEditContext = true;
    else if (!arg.startsWith('-') && !positionalSelection) positionalSelection = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  const selection = taskSelection || groupSelection || positionalSelection;
  return {
    selection,
    selectionSource: taskSelection
      ? 'task'
      : groupSelection
        ? 'group'
        : positionalSelection
          ? 'positional'
          : level !== undefined
            ? 'level'
            : null,
    level,
    outDir: path.resolve(outDir),
    // 注意保持原始值:'' 是「按场景自动解析」的哨兵;path.resolve('') 会把它污染成 cwd。
    baselinePath,
    updateBaseline,
    efficiencyGate,
    list,
    keep,
    ...(withoutGrepEditContext ? { withoutGrepEditContext } : {}),
    timeoutMs,
  };
}

/** 效率基线只有按「完整场景组」录制才有可比性;--update-baseline 必须落在单个场景组上。 */
export function validateShortPathOptions(
  options: ShortPathCliOptions,
  selectionScenarioName: ShortPathScenario | null,
): void {
  if (options.withoutGrepEditContext && (options.updateBaseline || options.efficiencyGate)) {
    throw new Error('--without-grep-edit-context is for comparisons and cannot update or gate a baseline');
  }
  if (!options.updateBaseline) return;
  if (options.selectionSource !== 'group' || selectionScenarioName === null) {
    throw new Error('--update-baseline requires a single-scenario --group (micro|hinted|warm|repo|l6|locate)');
  }
}

function isVerifyFile(fixturePath: string): boolean {
  return path.basename(fixturePath).startsWith('verify');
}

function materialize(root: string, fixture: ShortPathTask): void {
  for (const file of fixture.files) {
    const target = path.join(root, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    const content = file.eol === 'crlf' ? file.content.replace(/\r?\n/g, '\r\n') : file.content;
    writeFileSync(target, content, 'utf8');
  }
  if (!fixture.repoSnapshot) {
    writeFileSync(path.join(root, 'package.json'), '{"type":"module","private":true}\n', 'utf8');
  }
}

async function extractRepoSnapshot(root: string, options: { junctionNodeModules: boolean }): Promise<void> {
  const tarPath = path.join(mkdtempSync(path.join(tmpdir(), `${RUN_PREFIX}archive-`)), 'head.tar');
  try {
    await execFileAsync('git', ['-C', REPO_ROOT, 'archive', '--format=tar', '-o', tarPath, 'HEAD'], {
      windowsHide: true,
    });
    await execFileAsync('tar', ['-xf', tarPath, '-C', root], { windowsHide: true });
  } finally {
    rmSync(path.dirname(tarPath), { recursive: true, force: true });
  }
  if (options.junctionNodeModules) {
    const nodeModules = path.join(REPO_ROOT, 'node_modules');
    if (!existsSync(nodeModules)) {
      throw new Error(`repo scenario needs ${nodeModules}; run npm install first`);
    }
    // junction:Windows 目录链接,无需管理员;rmSync 清理时只删链接不递归真实 node_modules。
    symlinkSync(nodeModules, path.join(root, 'node_modules'), 'junction');
  }
}

async function prepareWorkspace(root: string, fixture: ShortPathTask): Promise<void> {
  if (fixture.repoSnapshot) await extractRepoSnapshot(root, { junctionNodeModules: true });
  materialize(root, fixture);
}

function verifierIntegrityHash(root: string, fixture: ShortPathTask): string | null {
  const verifyFiles = fixture.files.filter((file) => isVerifyFile(file.path));
  if (verifyFiles.length === 0) return null;
  const hash = createHash('sha256');
  for (const file of verifyFiles) {
    try {
      hash.update(readFileSync(path.join(root, file.path)));
    } catch {
      return null; // verifier 被删改 = 篡改
    }
  }
  return hash.digest('hex');
}

async function verify(root: string, command: string, timeoutMs: number): Promise<boolean> {
  const [program, ...args] = command.split(' ');
  try {
    await execFileAsync(program, args, { cwd: root, timeout: timeoutMs, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function shortPathPromptHash(systemPrompt: string): string {
  return createHash('sha256').update(systemPrompt).digest('hex').slice(0, 16);
}

function buildExperimentPrompt(withoutGrepEditContext: boolean): string {
  const prompt = buildCodingEvalSystemPrompt(CODING_EVAL_SESSION_ID);
  if (!withoutGrepEditContext) return prompt;
  const rule = /^- Edit against fresh exact text\..*$/m;
  if (!rule.test(prompt)) throw new Error('Cannot identify the grep edit-context rule for the control prompt');
  const legacyReadRule =
    '- Edit against a FRESH read: before editing, call read_file on the exact path and copy the exact target text. Never reconstruct old_string from a grep/summary/diff.';
  return prompt.replace(rule, legacyReadRule);
}

function configureGrepControl(runtimeContext: AgentRuntimeContext): void {
  const runtime = runtimeContext.toolRuntime;
  const tools = runtime.builtinTools.map<Tool>((tool) => {
    if (tool.name === 'grep') {
      const properties = { ...(tool.parameters.properties as Record<string, unknown>) };
      delete properties.edit_context;
      return {
        ...tool,
        parameters: { ...tool.parameters, properties },
        execute: (args, context) => tool.execute({ ...args, edit_context: false }, context),
        description: tool.description.replace(
          /^Pass context=.*$/m,
          'Pass context=2..5 to include neighbouring lines. Use read_file when you need exact edit text.',
        ),
      };
    }
    if (tool.name === 'edit_file') {
      return {
        ...tool,
        parameters: {
          ...tool.parameters,
          properties: {
            ...(tool.parameters.properties as Record<string, unknown>),
            expected_hash: {
              type: 'string',
              description:
                'SHA-256 from the latest read_file; required for line ranges, optional for text replacements.',
            },
          },
        },
        description: tool.description
          .replace(
            /^\*\*String replacement.*$/m,
            '**String replacement (default):** Copy old_string verbatim from a fresh read_file. It must occur exactly once; expected_hash is optional.',
          )
          .replace(
            'expected_hash from a fresh read_file or [edit_context ...] header',
            'expected_hash from a fresh read_file',
          ),
      };
    }
    return tool;
  });
  runtime.installBuiltinTools(tools);
}

/** 在物化后的工作区取提示词 hash，repo 场景与 runTask 使用相同的 archive 解包方式。 */
export async function probePromptHash(fixture: ShortPathTask, withoutGrepEditContext = false): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), `${RUN_PREFIX}prompt-${fixture.id}-`));
  const previousCwd = process.cwd();
  try {
    if (fixture.repoSnapshot) await extractRepoSnapshot(root, { junctionNodeModules: false });
    materialize(root, fixture);
    process.chdir(root);
    return shortPathPromptHash(buildExperimentPrompt(withoutGrepEditContext));
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

async function runTurn(
  runtime: ReturnType<typeof createRuntime>,
  runtimeContext: AgentRuntimeContext,
  history: ChatMessage[],
  input: string,
  signal: AbortSignal,
  systemPrompt: string,
  traceSink: AgentTraceEvent[],
): Promise<string[]> {
  const turn = await assembleCodingEvalTurn(input, signal, systemPrompt, { runtimeContext });
  const result = await runtime.run({
    turn: 'new',
    turnLabel: input,
    history,
    userInput: input,
    signal,
    toolPolicy: turn.toolPolicy,
    initialToolRoute: turn.initialToolRoute,
    hooks: {},
    onTraceEvent: (event) => traceSink.push(event),
    traceContext: { sessionId: 'eval-shortpath' },
  });
  return result.changedFiles ?? [];
}

async function runTask(
  fixture: ShortPathTask,
  keep: boolean,
  expectedPromptHash: string,
  timeoutOverride?: number,
  withoutGrepEditContext = false,
  traceCollector?: (trace: { id: string; events: AgentTraceEvent[]; warmupEvents: AgentTraceEvent[] }) => void,
): Promise<ShortPathTaskResult> {
  const root = mkdtempSync(path.join(tmpdir(), `${RUN_PREFIX}${fixture.id}-`));
  await prepareWorkspace(root, fixture);
  const integrityHash = verifierIntegrityHash(root, fixture);
  const previousCwd = process.cwd();
  const runtime = createRuntime({
    sandboxRoot: root,
    configOverrides: { permissionEnabled: false },
    initialMode: 'auto',
  });
  const runtimeContext = runtime.context;
  if (withoutGrepEditContext) configureGrepControl(runtimeContext);
  const timeoutMs = timeoutOverride ?? fixture.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const verifyTimeoutMs = fixture.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const isWarm = fixture.scenario === 'warm';

  const turn1Events: AgentTraceEvent[] = [];
  const scoredEvents: AgentTraceEvent[] = [];
  let changedFiles: string[] = [];
  let warmupMutated = false;
  let warmupReadCalls: number | null = null;
  let warmupDurationMs: number | undefined;
  let endToEndDurationMs: number | undefined;

  try {
    process.chdir(root);
    const systemPrompt = buildExperimentPrompt(withoutGrepEditContext);
    const actualPromptHash = shortPathPromptHash(systemPrompt);
    if (actualPromptHash !== expectedPromptHash) {
      throw new Error(
        `Short-path prompt hash drifted before ${fixture.id}: expected ${expectedPromptHash}, got ${actualPromptHash}`,
      );
    }
    // warm:两轮共享同一段 history(等价 REPL 的跨轮持久数组);其余场景单轮。
    const history: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
    if (isWarm) {
      if (!fixture.warmupGoal) throw new Error(`Warm fixture ${fixture.id} is missing warmupGoal`);
      const warmupStarted = Date.now();
      const turn1Changed = await runTurn(
        runtime,
        runtimeContext,
        history,
        fixture.warmupGoal,
        controller.signal,
        systemPrompt,
        turn1Events,
      );
      warmupDurationMs = Date.now() - warmupStarted;
      changedFiles = [...changedFiles, ...turn1Changed];
      warmupReadCalls = countReadOnlyCalls(turn1Events);
      warmupMutated = runtimeContext.getCurrentTurnMutationState().changedFiles.length > 0;
      scoredEvents.length = 0;
      const turn2Changed = await runTurn(
        runtime,
        runtimeContext,
        history,
        fixture.goal,
        controller.signal,
        systemPrompt,
        scoredEvents,
      );
      changedFiles = [...changedFiles, ...turn2Changed];
    } else {
      const singleChanged = await runTurn(
        runtime,
        runtimeContext,
        history,
        fixture.goal,
        controller.signal,
        systemPrompt,
        scoredEvents,
      );
      changedFiles = [...changedFiles, ...singleChanged];
    }

    endToEndDurationMs = Date.now() - started;
    const finalVerified = await verify(root, fixture.verificationCommand, verifyTimeoutMs);
    const verifierUnchanged = verifierIntegrityHash(root, fixture) === integrityHash;
    const timedOut = controller.signal.aborted;
    const efficiency = reduceShortPathEfficiency(scoredEvents);
    const expectedChanged = fixture.expected?.files ?? [];
    const expectedFilesTouched = expectedChanged.every((file) =>
      changedFiles.some((changedFile) => changedFile.replace(/\\/g, '/').endsWith(file)),
    );
    const verified =
      finalVerified && expectedFilesTouched && verifierUnchanged && !timedOut && !(isWarm && warmupMutated);
    const status: ShortPathTaskResult['status'] = timedOut ? 'timeout' : verified ? 'passed' : 'failed';
    return {
      id: fixture.id,
      title: fixture.title,
      scenario: fixture.scenario,
      level: fixture.level,
      status,
      finalVerifiedSuccess: verified,
      expectedFilesTouched,
      verifierUnchanged,
      warmupMutated,
      efficiency,
      warmupReadCalls,
      goldMaxToolCalls: fixture.gold.maxToolCalls,
      pathRatio: Number((efficiency.toolCalls / Math.max(fixture.gold.maxToolCalls, 1)).toFixed(3)),
      promptTokens: efficiency.promptTokens,
      completionTokens: efficiency.completionTokens,
      cachedTokens: efficiency.cachedTokens,
      durationMs: efficiency.durationMs || Date.now() - started,
      endToEndDurationMs,
      warmupDurationMs,
      changedFiles: [...changedFiles],
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const efficiency = reduceShortPathEfficiency(scoredEvents);
    return {
      id: fixture.id,
      title: fixture.title,
      scenario: fixture.scenario,
      level: fixture.level,
      status: controller.signal.aborted ? 'timeout' : 'error',
      finalVerifiedSuccess: false,
      expectedFilesTouched: false,
      verifierUnchanged: verifierIntegrityHash(root, fixture) === integrityHash,
      warmupMutated,
      efficiency,
      warmupReadCalls,
      goldMaxToolCalls: fixture.gold.maxToolCalls,
      pathRatio: Number((efficiency.toolCalls / Math.max(fixture.gold.maxToolCalls, 1)).toFixed(3)),
      promptTokens: efficiency.promptTokens,
      completionTokens: efficiency.completionTokens,
      cachedTokens: efficiency.cachedTokens,
      durationMs: efficiency.durationMs || Date.now() - started,
      endToEndDurationMs: endToEndDurationMs ?? Date.now() - started,
      warmupDurationMs,
      changedFiles: [...changedFiles],
      error: message,
    };
  } finally {
    clearTimeout(timer);
    traceCollector?.({ id: fixture.id, events: [...scoredEvents], warmupEvents: [...turn1Events] });
    await runtime.close();
    process.chdir(previousCwd);
    clearSkillActivation();
    if (!keep && root.startsWith(path.join(tmpdir(), RUN_PREFIX))) rmSync(root, { recursive: true, force: true });
  }
}

export async function shortPathMain(args = process.argv.slice(2)): Promise<void> {
  const options = parseShortPathArgs(args);
  if (options.list || (options.selection === '' && options.level === undefined)) {
    for (const task of [...shortPathTasks, ...locateTasks])
      console.log(`${task.id}\tL${task.level}\t${task.scenario}\t${task.title}`);
    if (!options.list) {
      console.log('\nChoose tasks explicitly; groups: micro|hinted|warm|repo|l6|locate; or --level 1..6.');
    }
    return;
  }

  const selected = options.selection ? selectShortPathTasks(options.selection) : selectByLevel(options.level!);
  const scenario = selectionScenario(selected);
  validateShortPathOptions(options, options.selectionSource === 'group' ? scenario : null);
  const promptHash = await probePromptHash(selected[0], options.withoutGrepEditContext);
  const experiment: NonNullable<ShortPathReport['experiment']> = {
    fixtureHash: shortPathPromptHash(JSON.stringify([...selected].sort((a, b) => a.id.localeCompare(b.id)))),
    reasoningEffort: config.reasoningEffort,
    routing: isToolRoutingEnabled() ? getRouterMode() : 'off',
    shortPathCompletion: config.shortPathCompletion,
    ...(options.withoutGrepEditContext || options.selection === 'locate'
      ? { grepEditContext: !options.withoutGrepEditContext }
      : {}),
  };
  const identity = {
    schemaVersion: 1 as const,
    model: config.model,
    promptHash,
    scenario,
    taskIds: selected.map((task) => task.id),
    experiment,
  };

  let baseline: ShortPathBaseline | undefined;
  // 基线 key:--group 用组名;--level 用 l<N>(与同名组共享基线);--task 用 scenario(只读语义)。
  const baselineKey =
    options.selectionSource === 'level'
      ? `l${options.level}`
      : options.selectionSource === 'group'
        ? options.selection
        : scenario;
  const baselinePath = resolveBaselinePath(options.baselinePath, baselineKey);
  // 基线只对「完整场景组」有意义;--task 混选/--level/跨组混选都会被拦下或降级。
  const isFullScenarioRun = options.selectionSource === 'group';
  if (isFullScenarioRun && !options.updateBaseline && !options.withoutGrepEditContext) {
    // 基线文件缺失 = 首次运行,降级为无门禁继续跑(等 --update-baseline 录制后再启用)。
    if (existsSync(baselinePath)) {
      baseline = readShortPathBaseline(baselinePath);
      const preflight = compareShortPathPreflight(identity, baseline);
      if (preflight.status === 'failed') throw new Error(renderShortPathComparison(preflight));
    } else {
      console.log('Baseline: no baseline file yet; running without regression gate.');
    }
  } else if (options.selectionSource === 'level') {
    console.log('Baseline: level selection does not compare against the per-scenario baseline.');
  }

  const results: ShortPathTaskResult[] = [];
  const perTaskTraces: Array<{ id: string; events: AgentTraceEvent[]; warmupEvents: AgentTraceEvent[] }> = [];
  for (const fixture of selected) {
    process.stdout.write(`[short-path] ${fixture.id} ${fixture.title} ... `);
    const result = await runTask(
      fixture,
      options.keep,
      promptHash,
      options.timeoutMs,
      options.withoutGrepEditContext,
      (trace) => perTaskTraces.push(trace),
    );
    results.push(result);
    console.log(`${result.status} (calls=${result.efficiency.toolCalls}, ratio=${result.pathRatio.toFixed(2)}x)`);
  }
  const report: ShortPathReport = createReport(
    {
      schemaVersion: 1,
      runId: randomUUID(),
      generatedAt: new Date().toISOString(),
      model: identity.model,
      promptHash: identity.promptHash,
      scenario: identity.scenario,
      selection: options.selection,
      experiment,
    },
    results,
  );
  mkdirSync(options.outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(options.outDir, `${stamp}.json`);
  const mdPath = path.join(options.outDir, `${stamp}.md`);
  writeReport(report, jsonPath, mdPath);
  const tracePath = path.join(options.outDir, `${stamp}.trace.jsonl`);
  writeFileSync(tracePath, perTaskTraces.map((trace) => JSON.stringify(trace)).join('\n') + '\n', 'utf8');

  let baselineFailed = false;
  if (options.updateBaseline) {
    writeShortPathBaseline(baselinePath, createRecordedShortPathBaseline(report));
    console.log(`Baseline updated: ${baselinePath}`);
  } else if (baseline) {
    const comparison = compareShortPathReport(report, baseline, options.efficiencyGate);
    baselineFailed = comparison.status === 'failed';
    console.log(`\n${renderShortPathComparison(comparison)}`);
  }

  console.log(`\n${renderSummary(report)}`);
  console.log(`JSON: ${jsonPath}\nSummary: ${mdPath}\nTrace: ${tracePath}`);
  if (report.summary.passed !== report.summary.tasks || baselineFailed) process.exitCode = 1;
}

const invoked =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
if (invoked)
  shortPathMain().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
