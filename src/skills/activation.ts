// inline skill 激活态(设计 §3.6):use_skill 成功加载 inline skill 时置位，
// 该 turn 内模型的 disallowed-tools 约束生效(constants.getRuntimeDisabledTools 消费)。
// 同一 turn 连续加载多个 inline skill 时 deny 取并集，只能继续收窄；下一次真实用户轮清除。
//
// 刻意不设 allowed 授权:inline 加载不过信任门禁,自动放行 confirm 级工具会让
// 未信任的项目 skill 绕过权限确认。allowed-tools 只在 fork 模式下经 spawnAgent
// 的工具白名单生效(runner.runSkill)。
//
// 叶子模块:仅依赖 toolmap(亦叶子),不引 tools/permissions/agent,避免环。

import { mapSkillToolName } from './toolmap.js';
import type { Skill } from './discover.js';

export interface SkillActivation {
  /** 最近加载的 skill，仅用于诊断。 */
  name: string;
  /** 命中即运行时禁用(幻觉调用也执行不了)。 */
  disallowed: Set<string> | null;
}

let active: SkillActivation | null = null;

/** use_skill 成功加载 inline skill 时调用；同一 turn 的 deny 只累加、不撤销。 */
export function activateSkill(skill: Skill): void {
  const disallowed = new Set(active?.disallowed ?? []);
  for (const token of skill.disallowedTools ?? []) {
    const mapped = mapSkillToolName(token);
    if (mapped) disallowed.add(mapped);
  }
  active = {
    name: skill.name,
    disallowed: disallowed.size > 0 ? disallowed : null,
  };
}

/** 用户新轮开始时清激活态。 */
export function clearSkillActivation(): void {
  active = null;
}

export function getActiveSkill(): SkillActivation | null {
  return active;
}
