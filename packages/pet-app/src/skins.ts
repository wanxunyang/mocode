// 皮肤(选宠物)相关的静态读取逻辑:解析 assets/pets/manifest.json,提供 id → 文件路径的查找。
// 找不到/解析失败均返回空列表——选皮是可选增强,不能影响桌宠核心状态展示功能启动。

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MoodKind } from './mood.js';
import type { PetState } from './protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SkinEntry {
  id: string;
  file: string;
  name: string;
  motionFile?: string;
  /**
   * mood 维度文案:在 mood 求值命中某种 MoodKind 时,从中随机挑一条优先于通用文案池展示
   * (见 quips.ts pickQuip)。Mocde 状态本身不会触发该字段。
   */
  quips?: Partial<Record<MoodKind, string[]>>;
  /**
   * pet state 维度文案:每次广播到渲染进程的 PetState(见 protocol.ts)命中某个 key 时,
   * 从中随机挑一条展示在气泡里(走 pet:mood IPC,mood 字段为 null,quip 字段为该条文案)——
   * 用于让皮肤对"任务完成 / 用户中断 / 报错"等瞬时状态也能挂个性化的吐槽短句。
   * 未配置或对应 key 为空数组时跳过(不展示额外文案,不影响主流程)。 */
  stateQuips?: Partial<Record<PetState, string[]>>;
}

let cached: SkinEntry[] | null = null;

/** assets/pets/ 目录的绝对路径。dist/skins.js 与 dist/assets/ 是同级(见 scripts/copy-static.mjs
 *  把源码 assets/ 整体复制到 dist/assets/),故用 __dirname/assets 而非 __dirname/../assets。 */
export function skinsDir(): string {
  return path.join(__dirname, 'assets', 'pets');
}

/** 从 manifest 里单个 pet 条目对象中,宽容解析出 motionFile/quips/stateQuips 三个可选字段。
 *  纯函数,不涉及文件 I/O,便于单元测试覆盖各种非法输入的容错行为。
 *  - motionFile:必须是 string,否则不设置该字段。
 *  - quips:必须是非 null 对象;逐个 key 校验 value 是否为 string[],非法 key 被跳过;
 *    若最终没有任何合法 key,则不设置 quips 字段。
 *  - stateQuips:与 quips 同结构(只是 key 集合是 PetState 而非 MoodKind);
 *    所有 key 都会被原样保留(parseClientMessage 已对 PetState 做合法性校验,这里不做二次校验
 *    以避免重复维护合法状态列表),但仍逐个校验 value 必须是 string[]。 */
export function parseSkinEntryExtras(
  pp: Record<string, unknown>
): { motionFile?: string; quips?: Partial<Record<MoodKind, string[]>>; stateQuips?: Partial<Record<PetState, string[]>> } {
  const result: { motionFile?: string; quips?: Partial<Record<MoodKind, string[]>>; stateQuips?: Partial<Record<PetState, string[]>> } = {};

  if (typeof pp.motionFile === 'string') {
    result.motionFile = pp.motionFile;
  }

  if (typeof pp.quips === 'object' && pp.quips !== null) {
    const rawQuips = pp.quips as Record<string, unknown>;
    const quips: Partial<Record<MoodKind, string[]>> = {};
    for (const key of Object.keys(rawQuips)) {
      const value = rawQuips[key];
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        quips[key as MoodKind] = value as string[];
      }
    }
    if (Object.keys(quips).length > 0) {
      result.quips = quips;
    }
  }

  if (typeof pp.stateQuips === 'object' && pp.stateQuips !== null) {
    const rawStateQuips = pp.stateQuips as Record<string, unknown>;
    const stateQuips: Partial<Record<PetState, string[]>> = {};
    for (const key of Object.keys(rawStateQuips)) {
      const value = rawStateQuips[key];
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        stateQuips[key as PetState] = value as string[];
      }
    }
    if (Object.keys(stateQuips).length > 0) {
      result.stateQuips = stateQuips;
    }
  }

  return result;
}

/** 读取 manifest.json 里的候选皮肤列表(带内存缓存,manifest 在运行期不会变化)。 */
export function listSkinEntries(): SkinEntry[] {
  if (cached) return cached;
  try {
    const manifestPath = path.join(skinsDir(), 'manifest.json');
    if (!existsSync(manifestPath)) {
      cached = [];
      return cached;
    }
    const raw = readFileSync(manifestPath, 'utf8');
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || !Array.isArray((obj as Record<string, unknown>).pets)) {
      cached = [];
      return cached;
    }
    const pets = (obj as Record<string, unknown>).pets as unknown[];
    const entries: SkinEntry[] = [];
    for (const p of pets) {
      if (!p || typeof p !== 'object') continue;
      const pp = p as Record<string, unknown>;
      if (typeof pp.id === 'string' && typeof pp.file === 'string' && typeof pp.name === 'string') {
        const entry: SkinEntry = { id: pp.id, file: pp.file, name: pp.name };
        const extras = parseSkinEntryExtras(pp);
        if (extras.motionFile !== undefined) entry.motionFile = extras.motionFile;
        if (extras.quips !== undefined) entry.quips = extras.quips;
        if (extras.stateQuips !== undefined) entry.stateQuips = extras.stateQuips;
        entries.push(entry);
      }
    }
    cached = entries;
    return cached;
  } catch {
    cached = [];
    return cached;
  }
}

/** 给定 skinId 解析出对应 SVG 的绝对路径;'default'/未知 id/空字符串均返回 null(表示用默认 mascot.svg)。 */
export function resolveSkinPath(skinId: string | undefined): string | null {
  if (!skinId || skinId === 'default') return null;
  const entry = listSkinEntries().find((e) => e.id === skinId);
  if (!entry) return null;
  return path.join(skinsDir(), entry.file);
}
