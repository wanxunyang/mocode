// 离线验证 skill 系统核心逻辑(不连后端、不依赖真实 skill 目录):
//   parseFrontmatter / resolveSkillsDirs / discoverSkills(优先级去重 + 跳过缺 description)
//   getSkillBody(去 frontmatter + trim)/ capToolResultForHistory 的 use_skill 分支(放宽 + 尾截)
//   与默认分支不回归(仍中截 <= MAX_HISTORY_RESULT)。
// 运行:npx tsx scripts/check-skills.ts
//
// 先设 dummy env 避免 config.requireEnv 退出,再用动态 import(静态 import 会先于 env 设置执行)。

import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  const { parseFrontmatter, resolveSkillsDirs, discoverSkills } = await import(
    '../src/skills/discover.js'
  );
  const { capToolResultForHistory } = await import('../src/session/compact.js');
  const { MAX_SKILL_RESULT, MAX_HISTORY_RESULT } = await import(
    '../src/tools/constants.js'
  );

  // 1) parseFrontmatter:首冒号切 + 去引号 + 多字段 + body
  {
    const r = parseFrontmatter(
      '---\nname: demo\ndescription: "use when: foo"\nversion: 1.0\n---\nbody line'
    );
    assert(r.meta.name === 'demo', 'parseFrontmatter meta.name');
    assert(
      r.meta.description === 'use when: foo',
      'parseFrontmatter 首冒号切 + 去配对引号'
    );
    assert(r.meta.version === '1.0', 'parseFrontmatter meta.version');
    assert(r.body === 'body line', 'parseFrontmatter body');
  }

  // 2) parseFrontmatter:无 frontmatter → meta 空、body 原文
  {
    const r = parseFrontmatter('no frontmatter here');
    assert(Object.keys(r.meta).length === 0, 'parseFrontmatter 无 fm: meta 空');
    assert(r.body === 'no frontmatter here', 'parseFrontmatter 无 fm: body 原文');
  }

  // 3) parseFrontmatter:值含冒号无引号 → 按首个冒号切
  {
    const r = parseFrontmatter('---\nname: x\ndescription: Use when: bar\n---\nb');
    assert(
      r.meta.description === 'Use when: bar',
      'parseFrontmatter 值含冒号(无引号)按首个冒号切'
    );
  }

  // 4) resolveSkillsDirs:设 SKILLS_DIRS 覆盖(按 path.delimiter 切分)
  {
    process.env.SKILLS_DIRS = '/tmp/a' + path.delimiter + '/tmp/b';
    const dirs = resolveSkillsDirs();
    assert(
      dirs.length === 2 && dirs[0] === '/tmp/a' && dirs[1] === '/tmp/b',
      'resolveSkillsDirs 设 env 覆盖(按 path.delimiter 切分)'
    );
    delete process.env.SKILLS_DIRS;
  }

  // 5) discoverSkills:临时目录发现 + 优先级去重(后设覆盖先设)+ 跳过无 SKILL.md
  {
    const low = mkdtempSync(path.join(os.tmpdir(), 'mocode-skill-low-'));
    const high = mkdtempSync(path.join(os.tmpdir(), 'mocode-skill-high-'));
    mkdirSync(path.join(low, 'dup'), { recursive: true });
    writeFileSync(
      path.join(low, 'dup', 'SKILL.md'),
      '---\nname: dup\ndescription: from-low\n---\nlow body'
    );
    mkdirSync(path.join(high, 'dup'), { recursive: true });
    writeFileSync(
      path.join(high, 'dup', 'SKILL.md'),
      '---\nname: dup\ndescription: from-high\n---\nhigh body'
    );
    mkdirSync(path.join(high, 'another'), { recursive: true });
    writeFileSync(
      path.join(high, 'another', 'SKILL.md'),
      '---\nname: another\ndescription: second skill\n---\nanother body'
    );
    mkdirSync(path.join(high, 'no-skill-md'), { recursive: true }); // 无 SKILL.md,应跳过

    process.env.SKILLS_DIRS = low + path.delimiter + high; // 低 → 高
    const skills = discoverSkills();
    assert(
      skills.length === 2,
      'discoverSkills 发现 2 个(同名去重 + 跳过无 SKILL.md)'
    );
    const dup = skills.find((s) => s.name === 'dup');
    assert(
      !!dup && dup.description === 'from-high',
      'discoverSkills 优先级去重(高优先覆盖低优先)'
    );
    assert(!!skills.find((s) => s.name === 'another'), 'discoverSkills 发现 another');
    assert(
      !skills.some((s) => s.name === 'no-skill-md'),
      'discoverSkills 跳过无 SKILL.md 的目录'
    );
    delete process.env.SKILLS_DIRS;
    rmSync(low, { recursive: true, force: true });
    rmSync(high, { recursive: true, force: true });
  }

  // 6) discoverSkills:缺 description 的 skill 被跳过(description 是主触发机制)
  {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mocode-skill-nodesc-'));
    mkdirSync(path.join(tmp, 'nodesc'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'nodesc', 'SKILL.md'),
      '---\nname: nodesc\n---\nno desc'
    );
    process.env.SKILLS_DIRS = tmp;
    assert(discoverSkills().length === 0, 'discoverSkills 跳过缺 description 的 skill');
    delete process.env.SKILLS_DIRS;
    rmSync(tmp, { recursive: true, force: true });
  }

  // 7) getSkillBody:读正文(去 frontmatter + trim);找不到返 null
  {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mocode-skill-body-'));
    mkdirSync(path.join(tmp, 'gb'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'gb', 'SKILL.md'),
      '---\nname: gb\ndescription: body test\n---\n\n# Title\n\nstep 1\n'
    );
    process.env.SKILLS_DIRS = tmp;
    const { listSkills, getSkillBody } = await import('../src/skills/index.js');
    listSkills(); // 触发缓存(用当前 env)
    const body = getSkillBody('gb');
    assert(body !== null, 'getSkillBody 找到 skill');
    assert(!!body && body.startsWith('# Title'), 'getSkillBody 去 frontmatter + 前导空行');
    assert(!!body && !body.includes('---'), 'getSkillBody 正文不含 frontmatter 围栏');
    assert(getSkillBody('nope') === null, 'getSkillBody 找不到返 null');
    delete process.env.SKILLS_DIRS;
    rmSync(tmp, { recursive: true, force: true });
  }

  // 8) capToolResultForHistory:use_skill 走分支(放宽到 MAX_SKILL_RESULT + 尾截,不中截)
  {
    const big = 'A'.repeat(MAX_SKILL_RESULT + 10000);
    const capped = capToolResultForHistory('use_skill', big);
    assert(
      capped.length <= MAX_SKILL_RESULT,
      `use_skill 裁到 <= MAX_SKILL_RESULT(${MAX_SKILL_RESULT})`
    );
    assert(capped.includes('skill 正文过长'), 'use_skill 含 skill 正文过长标记(尾截)');
    assert(capped.startsWith('A'.repeat(100)), 'use_skill 尾截保头部(不中截)');
    assert(!capped.endsWith('A'), 'use_skill 尾部是标记非原文(非中截保尾)');
    assert(
      capToolResultForHistory('use_skill', 'short') === 'short',
      'use_skill 短正文不裁'
    );
  }

  // 9) capToolResultForHistory:默认分支不回归(run_command 仍 <= MAX_HISTORY_RESULT + 中截)
  {
    const big = 'X'.repeat(MAX_HISTORY_RESULT + 10000);
    const capped = capToolResultForHistory('run_command', big);
    assert(
      capped.length <= MAX_HISTORY_RESULT,
      `run_command 仍 <= MAX_HISTORY_RESULT(${MAX_HISTORY_RESULT})(默认分支不回归)`
    );
    assert(capped.includes('已截断'), 'run_command 含已截断标记');
    assert(capped.endsWith('X'), 'run_command 中截保尾(与 use_skill 尾截区分)');
    assert(!capped.includes('skill 正文过长'), 'run_command 不走 use_skill 分支');
  }

  console.log('\nOK: skills 系统核心逻辑全部通过');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
