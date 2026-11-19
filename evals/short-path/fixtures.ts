import { hintedTasks } from './fixtures-hinted.js';
import { l6TasksA } from './fixtures-l6a.js';
import { l6TasksB } from './fixtures-l6b.js';
import { microTasks } from './fixtures-micro.js';
import { repoTasks } from './fixtures-repo.js';
import { warmTasks } from './fixtures-warm.js';
import type { ShortPathScenario, ShortPathTask } from './types.js';

export const shortPathTasks: ShortPathTask[] = [
  ...microTasks,
  ...hintedTasks,
  ...warmTasks,
  ...repoTasks,
  ...l6TasksA,
  ...l6TasksB,
];

export const SHORT_PATH_GROUPS = ['micro', 'hinted', 'warm', 'repo', 'l6'] as const;
export type ShortPathGroup = (typeof SHORT_PATH_GROUPS)[number];

export function groupTasks(group: ShortPathGroup): ShortPathTask[] {
  switch (group) {
    case 'micro':
      return microTasks;
    case 'hinted':
      return hintedTasks;
    case 'warm':
      return warmTasks;
    case 'repo':
      return repoTasks;
    case 'l6':
      return [...l6TasksA, ...l6TasksB];
  }
}

/** 一次运行只允许一个场景:系统提示(AGENTS.md 注入)随场景不同,promptHash 无法代表混合集合。 */
export function selectionScenario(tasks: readonly ShortPathTask[]): ShortPathScenario {
  const scenarios = new Set(tasks.map((task) => task.scenario));
  if (scenarios.size !== 1) {
    throw new Error(
      `Short-path eval selection mixes scenarios (${[...scenarios].join(', ')}); run one scenario at a time.`,
    );
  }
  return [...scenarios][0];
}

/** 按复杂度等级选题(L1-L5 已覆盖;--level 入口)。level 与 scenario 一一映射,天然满足单场景强制。 */
export function selectByLevel(level: number): ShortPathTask[] {
  const selected = shortPathTasks.filter((task) => task.level === level);
  if (selected.length === 0) {
    throw new Error(`No short-path tasks at level ${level}; covered levels are 1-5 (L6-L10 reserved).`);
  }
  return selected;
}

export function selectShortPathTasks(selection: string): ShortPathTask[] {
  if ((SHORT_PATH_GROUPS as readonly string[]).includes(selection)) return groupTasks(selection as ShortPathGroup);
  const ids = selection
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const selected = ids.map((id) => {
    const task = shortPathTasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error(`Unknown short-path task id: ${id}`);
    return task;
  });
  if (selected.length === 0) throw new Error('No short-path tasks selected');
  return selected;
}
