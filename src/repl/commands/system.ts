/**
 * 系统命令组:/help · /language · /init · /upgrade
 *
 * 控制流改写说明(/upgrade now 成功路径):
 * 原分支在 try 块内直接 `break` 跳出 while 主循环(finally 里 stopRunningListener 仍执行)。
 * 搬进 handler 后无法 break 调用方的循环,改为置 `exitAfter = true`,handler 返回
 * outcome.kind === 'exit',runtime.ts 的 switch 负责 break——finally 时序不变。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { bannerLines } from '../../ui/render.js';
import { t, getLanguage, normalizeLanguage } from '../../i18n/index.js';
import { updateLanguageConfig, languageFromShell, hasCodegraphIndex } from '../../config/index.js';
import { updateConfigKey } from '../../config/file.js';
import { getAgentMode } from '../../agent/mode.js';
import { buildSlashCommands, slashHelpLines, HELP_GROUPS } from '../commands.js';
import { startRunningListener, stopRunningListener } from '../running-input.js';
import { checkVersion, fetchLatestVersion, getCurrentVersion, runUpgradeForeground } from '../../commands/upgrade.js';
import { unhandled, next, exit, forward, type CommandHandler } from './types.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * /init 指令:发给 agent 扫描项目并生成 AGENTS.md。整体重写(非增量追加),预算分配制:
 * 总长 ≤4000 字且 ≤ 旧文件字数(代码侧动态注入具体数字),装不下的高价值事实进
 * .mocode/agents-draft.md 草稿而非硬塞,消除「删事实 vs 守预算」两难。写完供 memory 子系统下轮加载。
 *
 * 函数化(非 const):.codegraph/ 索引与旧文件字数的探测放在调用瞬间,没索引时不提 codegraph,
 * 避免 LLM 调出失败。/init 是冷启动动作,IO 开销可忽略。
 */
function buildInitPrompt(): string {
  const cg = hasCodegraphIndex()
    ? '- 若有 .codegraph/:用 use_skill 加载 codegraph skill 后用 run_command 调 codegraph explore "<架构或入口符号>" 一次拿相关源码+调用路径,别逐文件读！！！\n'
    : '';
  // 动态注入旧文件字数:具体数字的遵循率远高于抽象原则(「≤4000」);首次生成时无旧文件则只约束绝对上限。
  let oldSizeNote = '';
  try {
    const old = fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf8');
    if (old.trim()) oldSizeNote = `旧 AGENTS.md 为 ${old.length} 字(新文件净字数必须 ≤ ${Math.min(4000, old.length)}:既守 4000 上限也守零和,超出即继续删低价值条目直到达标)。`;
  } catch {
    // 无旧文件:首次生成,只受 4000 字绝对上限约束。
  }
  return `分析当前项目(process.cwd()),生成 AGENTS.md 项目记忆文件,供 mocode 后续会话自动加载——目标是让后续会话无需重新摸索就能上手。

先探查(尽量少调用拿全貌):
${cg}- read_file package.json(或 Cargo.toml/pyproject.toml/go.mod 等):scripts、依赖、入口、模块类型。
- glob 顶层目录;read_file 入口文件 + 各子系统 index.ts/README。
- 若 AGENTS.md 已存在:read_file 读它。**整体重写,不是增量追加**——不要把旧文当底稿做增量,从下面的预算出发重新分配每一条;以当前代码为准,过时/弱事实直接删,准确且仍高价值的可沿用。
- 若 .mocode/agents-draft.md 存在:read_file 读它,把草稿里的稳定事实合入对应章节,完成后用 write_file 覆盖为空(或删除该文件)。

AGENTS.md 按以下结构写(每节简短,只写稳定、非显然的事实):
## 项目
一两句:是什么、技术栈、运行环境。
## 命令
install / dev / build / test / typecheck / lint 等——从 package.json scripts 提炼,写原样命令行(如 \`npm run build\`);没有的注明"无测试"/"无 lint"。
## 目录结构
顶层各目录与子系统职责,一句话/个;不逐文件列。此节系统提示不会常驻注入(按需 read_file),够用即可。
## 约定
从代码与现有文档提炼的硬约定:模块系统(ESM?)、命名、错误处理、工具/函数契约、易踩坑点。只写非显然、会让人踩坑的;不写"保持简洁"这种正确废话。
## 扩展点
加工具/命令/provider/模块的接缝(改哪个文件、加在哪)。此节同样不常驻注入,保持简短。

预算(硬上限,按字分配,参考):
- 总长 ≤ 4000 字${oldSizeNote ? `,且 ${oldSizeNote}` : '(首次生成)'}。参考分配:项目 ≤200、命令 ≤650、目录结构 ≤400、约定 ≤2000、扩展点 ≤400。
- **预算装不下但确有高价值的事实不丢**:write_file(append=true) 追加到 \`.mocode/agents-draft.md\`(一行一条,注明所属章节),下次 /init 再评估合入。禁止为了塞进预算牺牲准确性,也禁止超预算硬塞。

硬要求:
- 从实际代码提炼,引用具体文件名/命令/符号;不编造、不泛泛。
- 只写后续会话有用的稳定事实,不写易变项(当前 bug、临时文件、未决 TODO)。
- 写入前 run_command \`wc -m AGENTS.md\` 不可用(文件还没写);改用你草稿的字数估算,并按 ${oldSizeNote ? '上述净删目标' : '4000 字上限'}自查,超了先删再写。
- 用 write_file 写入项目根 AGENTS.md;**写完立即 read_file AGENTS.md 复查实际字数**,超限则编辑收窄后重写,直到达标。
- 最终简述必须含对账三件套(供用户验收,缺一不可):①新旧字数对比(旧 X → 新 Y,无旧文件写"首建 Y");②删掉的条目清单(标题级);③新增的条目清单(标题级)+ 从代码里发现的 2-3 条非显然关键约定。`;
}

export const systemCommands: CommandHandler[] = [
  (ctx) => {
    if (ctx.line !== '/help') return unhandled();
    const nodes = buildSlashCommands();
    layout.contentWrite(`${ui.bold}${t('help.title')}${ui.reset}\n`);
    layout.contentWrite(`${ui.dim}${t('help.hint')}${ui.reset}\n`);
    // 按使用场景分组输出,常用置顶;未归组命令(如 /exit)兜底进「其他」。
    let first = true;
    for (const group of HELP_GROUPS) {
      const picked = nodes.filter((n) => group.names.includes(n.name));
      if (!picked.length) continue;
      if (!first) layout.contentWrite('\n');
      first = false;
      layout.contentWrite(`${ui.accent}${ui.bold}${t(group.key)}${ui.reset}\n`);
      layout.contentWrite(`${slashHelpLines(picked).join('\n')}\n`);
    }
    const rest = nodes.filter((n) => !HELP_GROUPS.some((g) => g.names.includes(n.name)));
    if (rest.length) {
      if (!first) layout.contentWrite('\n');
      layout.contentWrite(`${ui.accent}${ui.bold}${t('help.groupOther')}${ui.reset}\n`);
      layout.contentWrite(`${slashHelpLines(rest).join('\n')}\n`);
    }
    return next();
  },
  (ctx) => {
    const { line } = ctx;
    if (line !== '/language' && !line.startsWith('/language ')) return unhandled();
    const arg = line === '/language' ? '' : line.slice('/language '.length).trim();
    if (!arg) {
      const currentName = getLanguage() === 'zh-CN' ? t('language.zh') : t('language.en');
      layout.contentWrite(`${ui.dim}${t('language.current', { language: currentName })}${ui.reset}\n`);
      layout.contentWrite(`${ui.dim}${t('language.usage')}${ui.reset}\n\n`);
      return next();
    }
    const nextLang = normalizeLanguage(arg);
    if (!nextLang) {
      layout.contentWrite(`${ui.yellow}${t('language.invalid', { value: arg })}${ui.reset}\n\n`);
      return next();
    }
    updateLanguageConfig(nextLang);
    updateConfigKey('MOCODE_LANGUAGE', nextLang);
    ctx.history[0] = { role: 'system', content: ctx.buildSystemMessage(getAgentMode() === 'plan') };
    ctx.refreshStatusBase(ctx.history);
    // 横幅是内容缓冲顶部的固定区域；语言切换后等长原地替换，不移动后续对话。
    layout.rewriteBanner(bannerLines(ctx.banner()));
    layout.contentWrite(`${ui.cyan}${t('language.changed')}${ui.reset}\n`);
    if (languageFromShell) {
      layout.contentWrite(`${ui.dim}${t('language.shellOverride')}${ui.reset}\n`);
    }
    layout.contentWrite('\n');
    return next();
  },
  (ctx) => {
    if (ctx.line !== '/init') return unhandled();
    // /init:把 init 指令当 user 输入发给 agent(扫描项目 + 生成 AGENTS.md),fall through 走 runAgent
    return forward(buildInitPrompt());
  },
  async (ctx) => {
    const { line } = ctx;
    if (line !== '/upgrade' && !line.startsWith('/upgrade ')) return unhandled();
    const arg = line === '/upgrade' ? '' : line.slice('/upgrade '.length).trim().toLowerCase();

    // /upgrade check — 联网检查当前版本与最新版本差异
    if (arg === 'check') {
      startRunningListener(t('running.upgrading'));
      try {
        const info = await checkVersion();
        if (!info.latest) {
          layout.contentWrite(`${ui.yellow}⚠ ${t('upgrade.fetchFailed')}${ui.reset}\n`);
        } else if (info.hasUpdate) {
          layout.contentWrite(
            `${ui.cyan}● ${t('upgrade.hasUpdate', { current: info.current, latest: info.latest })}${ui.reset}\n`,
          );
          layout.contentWrite(`${ui.dim}${t('upgrade.checkHint')}${ui.reset}\n`);
        } else {
          layout.contentWrite(`${ui.green}✓ ${t('upgrade.noUpdate', { version: info.current })}${ui.reset}\n`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        layout.contentWrite(`${ui.red}${t('upgrade.failed', { message: msg })}${ui.reset}\n`);
      } finally {
        stopRunningListener();
      }
      return next();
    }

    // /upgrade status — 只显示本地当前版本(不联网)
    if (arg === 'status') {
      const current = getCurrentVersion();
      layout.contentWrite(`${ui.dim}${t('upgrade.currentVersion', { version: `v${current}` })}${ui.reset}\n`);
      layout.contentWrite(`${ui.dim}${t('upgrade.pkgName')}${ui.reset}\n`);
      return next();
    }

    // /upgrade 或 /upgrade now — 前台执行升级,实时显示 npm 输出
    if (arg === '' || arg === 'now') {
      // 原实现升级成功后在 try 内 `break` 跳出 REPL 主循环;handler 无法 break 调用方,
      // 改为置标志 + 返回 exit,由 runtime.ts 的 switch 执行 break(finally 时序不变)。
      let exitAfterUpgrade = false;
      startRunningListener(t('running.upgrading'));
      try {
        const latest = await fetchLatestVersion();
        const current = getCurrentVersion();
        if (latest && latest === current) {
          layout.contentWrite(`${ui.green}✓ ${t('upgrade.noUpdate', { version: current })}${ui.reset}\n`);
          return next();
        }
        const target = latest ?? 'latest';
        layout.contentWrite(`${ui.cyan}● ${t('upgrade.begin', { version: target })}${ui.reset}\n`);

        const result = await runUpgradeForeground((chunk) => {
          layout.contentWrite(chunk);
        });

        if (result.ok) {
          layout.contentWrite(`\n${ui.green}${ui.bold}✓ ${t('upgrade.completed')}${ui.reset}\n`);
          // 给用户 2.5 秒看清提示,然后自动退出,下次启动即使用新版本。
          await new Promise((resolve) => setTimeout(resolve, 2500));
          exitAfterUpgrade = true;
        } else {
          layout.contentWrite(
            `${ui.red}✗ ${t('upgrade.failedWithCode', { code: String(result.exitCode ?? 'unknown') })}${ui.reset}\n`,
          );
          if (result.output.includes('ETARGET') || result.output.includes('No matching version found')) {
            layout.contentWrite(`${ui.yellow}${t('upgrade.etargetHint')}${ui.reset}\n`);
          } else {
            layout.contentWrite(`${ui.dim}${t('upgrade.manualHint')}${ui.reset}\n`);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        layout.contentWrite(`${ui.red}${t('upgrade.failed', { message: msg })}${ui.reset}\n`);
      } finally {
        stopRunningListener();
      }
      return exitAfterUpgrade ? exit() : next();
    }

    // 未知子命令
    layout.contentWrite(`${ui.yellow}${t('upgrade.usage')}${ui.reset}\n`);
    return next();
  },
];
