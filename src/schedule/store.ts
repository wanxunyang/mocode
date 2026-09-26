// 调度计划存储：<sandboxRoot>/.mocode/schedules/<id>.json。
// 一个 schedule 有两种触发方式：cron（周期）或 webhook（仅 HTTP 触发，cron 为空串）。
// 同一 schedule 也可两者并存（cron 表达式 + webhookToken 都配）。

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getSandboxRoot } from '../sandbox/index.js';
import { parseCron } from './cron.js';

export interface ScheduleRecord {
  id: string;
  name: string;
  prompt: string;
  /** 5 段 cron；空串表示仅 webhook 触发。 */
  cron: string;
  enabled: boolean;
  /** webhook 触发令牌（路径 /trigger/<token>）；不配则不可被 HTTP 触发。 */
  webhookToken?: string;
  worktree?: boolean;
  sessionDir?: string;
  createdAt: string;
  lastRunAt?: string;
}

function schedulesRoot(): string {
  return path.join(getSandboxRoot() ?? process.cwd(), '.mocode', 'schedules');
}

function recordPath(id: string): string {
  return path.join(schedulesRoot(), `${id}.json`);
}

export function createScheduleId(): string {
  return `sch-${Date.now()}-${randomBytes(2).toString('hex')}`;
}

/** 校验候选字段；非法（cron 语法错 / 无任何触发器）抛错。 */
function validate(cron: string, webhookToken: string | undefined): void {
  if (cron.trim() !== '') parseCron(cron);
  if (!cron.trim() && !webhookToken) {
    throw new Error('schedule needs a cron expression or a webhook token (no trigger configured)');
  }
}

export function saveSchedule(record: ScheduleRecord): void {
  fs.mkdirSync(schedulesRoot(), { recursive: true });
  const target = recordPath(record.id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
}

export function getSchedule(id: string): ScheduleRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordPath(id), 'utf8')) as ScheduleRecord;
  } catch {
    return null;
  }
}

export interface NewScheduleInput {
  name: string;
  prompt: string;
  cron?: string;
  webhook?: boolean;
  worktree?: boolean;
  sessionDir?: string;
}

/** 创建并落盘一个 schedule。 */
export function createSchedule(input: NewScheduleInput): ScheduleRecord {
  const cron = (input.cron ?? '').trim();
  const webhookToken = input.webhook ? randomBytes(8).toString('hex') : undefined;
  validate(cron, webhookToken);
  const record: ScheduleRecord = {
    id: createScheduleId(),
    name: input.name,
    prompt: input.prompt,
    cron,
    enabled: true,
    ...(webhookToken ? { webhookToken } : {}),
    ...(input.worktree ? { worktree: true } : {}),
    ...(input.sessionDir ? { sessionDir: input.sessionDir } : {}),
    createdAt: new Date().toISOString(),
  };
  saveSchedule(record);
  return record;
}

export function updateSchedule(id: string, patch: Partial<ScheduleRecord>): ScheduleRecord | null {
  const current = getSchedule(id);
  if (!current) return null;
  const next: ScheduleRecord = { ...current, ...patch };
  validate(next.cron, next.webhookToken);
  saveSchedule(next);
  return next;
}

export function deleteSchedule(id: string): boolean {
  try {
    fs.rmSync(recordPath(id));
    return true;
  } catch {
    return false;
  }
}

export function listSchedules(): ScheduleRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(schedulesRoot());
  } catch {
    return [];
  }
  const records: ScheduleRecord[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(schedulesRoot(), file), 'utf8')) as ScheduleRecord);
    } catch {
      // skip corrupt
    }
  }
  return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
