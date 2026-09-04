/**
 * Skill 命令组:/skills · /skill <name> [args-json]
 *
 * 顺序敏感:`/skills` 必须排在 `/skill` 之前——`/skill` 用 startsWith('/skill ')
 * 匹配带参形式,裸 '/skills' 不会命中它,但保持原 if 链的相对顺序最稳妥。
 *
 * /skill 的 inline 分支只预览:正文不进模型 history,不激活工具面约束。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { listSkills, findSkill } from '../../skills/index.js';
import { runSkill, renderSkillBody } from '../../skills/runner.js';
import { isSkillTrusted } from '../../skills/trust.js';
import { unhandled, next, type CommandHandler } from './types.js';

export const skillCommands: CommandHandler[] = [
  (ctx) => {
    if (ctx.line !== '/skills') return unhandled();
    const skills = listSkills();
    if (skills.length === 0) {
      layout.contentWrite(`${ui.dim}(没有已发现的 skill)${ui.reset}\n`);
    } else {
      layout.contentWrite(`${ui.dim}已发现 ${skills.length} 个 skill:${ui.reset}\n`);
      for (const s of skills) {
        const badges: string[] = [];
        if (s.context === 'fork') badges.push('fork');
        if (!s.modelInvocable) badges.push('manual-only');
        badges.push(s.origin);
        if (s.origin === 'project') {
          badges.push(isSkillTrusted(s) ? 'trusted' : 'untrusted');
        }
        const badgeStr = badges.length ? ` ${ui.dim}[${badges.join('|')}]${ui.reset}` : '';
        layout.contentWrite(`  ${ui.accent}${s.name}${ui.reset}${badgeStr}  ${ui.dim}${s.description}${ui.reset}\n`);
        if (s.allowedTools?.length) {
          layout.contentWrite(`    ${ui.dim}allowed: ${s.allowedTools.join(', ')}${ui.reset}\n`);
        }
        if (s.disallowedTools?.length) {
          layout.contentWrite(`    ${ui.dim}disallowed: ${s.disallowedTools.join(', ')}${ui.reset}\n`);
        }
        if (s.warnings.length) {
          layout.contentWrite(`    ${ui.dim}warnings: ${s.warnings.join('; ')}${ui.reset}\n`);
        }
      }
      layout.contentWrite(
        `${ui.dim}(用 use_skill 加载指令; fork 类用 run_skill 执行; 也支持 /skill <name> [args-json])${ui.reset}\n`,
      );
    }
    return next();
  },
  // /skill <name> [args-json]:直接执行一个 skill(fork 走 run_skill,inline 打印渲染后正文)。
  async (ctx) => {
    const { line } = ctx;
    if (line !== '/skill' && !line.startsWith('/skill ')) return unhandled();
    const rest = line.slice('/skill'.length).trim();
    const sp = rest.indexOf(' ');
    const name = sp === -1 ? rest : rest.slice(0, sp);
    const argStr = sp === -1 ? '' : rest.slice(sp + 1).trim();
    if (!name) {
      layout.contentWrite(`${ui.dim}用法: /skill <name> [args-json]${ui.reset}\n`);
      return next();
    }
    let args: Record<string, unknown> | undefined;
    if (argStr) {
      try {
        args = JSON.parse(argStr);
      } catch {
        layout.contentWrite(`${ui.dim}args 不是合法 JSON,已忽略。${ui.reset}\n`);
      }
    }
    const skill = findSkill(name);
    if (!skill) {
      layout.contentWrite(`错误:未找到 skill "${name}"。\n`);
      return next();
    }
    if (skill.context === 'fork') {
      layout.contentWrite(`${ui.dim}执行 fork skill "${name}"…${ui.reset}\n`);
      const out = await runSkill({ name, args });
      layout.contentWrite((out.status === 'success' ? '' : `[${out.status}] `) + out.output + '\n');
    } else {
      const body = await renderSkillBody(skill, args);
      if (body === null) layout.contentWrite(`错误:未找到 skill "${name}" 的正文。\n`);
      else {
        // 仅预览:inline 正文未进入模型 history,不激活工具面约束;
        // 要让模型按此 skill 工作,请让它调 use_skill(name) 或在下条消息里提及该 skill。
        layout.contentWrite(`# Skill: ${name}(预览,模型尚未看到此内容)\n\n${body}\n`);
      }
    }
    return next();
  },
];
