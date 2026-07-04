// 皮肤(选宠物)相关的静态读取逻辑:解析 assets/pets/manifest.json,提供 id → 文件路径的查找。
// 找不到/解析失败均返回空列表——选皮是可选增强,不能影响桌宠核心状态展示功能启动。

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MoodKind } from './mood.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SkinEntry {
  id: string;
  file: string;
  name: string;
  motionFile?: string;
  quips?: Partial<Record<MoodKind, string[]>>;
}

let cached: SkinEntry[] | null = null;

/** assets/pets/ 目录的绝对路径。dist/skins.js 与 dist/assets/ 是同级(见 scripts/copy-static.mjs
 *  把源码 assets/ 整体复制到 dist/assets/),故用 __dirname/assets 而非 __dirname/../assets。 */
export function skinsDir(): string {
  return path.join(__dirname, 'assets', 'pets');
}

/** 从 manifest 里单个 pet 条目对象中,宽容解析出 motionFile/quips 两个可选字段。
 *  纯函数,不涉及文件 I/O,便于单元测试覆盖各种非法输入的容错行为。
 *  - motionFile:必须是 string,否则不设置该字段。
 *  - quips:必须是非 null 对象;逐个 key 校验 value 是否为 string[],非法 key 被跳过;
 *    若最终没有任何合法 key,则不设置 quips 字段。 */
export function parseSkinEntryExtras(
  pp: Record<string, unknown>
): { motionFile?: string; quips?: Partial<Record<MoodKind, string[]>> } {
  const result: { motionFile?: string; quips?: Partial<Record<MoodKind, string[]>> } = {};

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
