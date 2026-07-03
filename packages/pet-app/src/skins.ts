// 皮肤(选宠物)相关的静态读取逻辑:解析 assets/pets/manifest.json,提供 id → 文件路径的查找。
// 找不到/解析失败均返回空列表——选皮是可选增强,不能影响桌宠核心状态展示功能启动。

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SkinEntry {
  id: string;
  file: string;
  name: string;
}

let cached: SkinEntry[] | null = null;

/** assets/pets/ 目录的绝对路径。dist/skins.js 与 dist/assets/ 是同级(见 scripts/copy-static.mjs
 *  把源码 assets/ 整体复制到 dist/assets/),故用 __dirname/assets 而非 __dirname/../assets。 */
export function skinsDir(): string {
  return path.join(__dirname, 'assets', 'pets');
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
        entries.push({ id: pp.id, file: pp.file, name: pp.name });
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
