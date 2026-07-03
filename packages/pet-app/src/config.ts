// 桌宠本地持久化配置(悬浮窗位置 + 当前皮肤),存于 Electron userData 目录下的 pet-config.json。
// 读写失败均静默降级为默认值——配置持久化是纯增强功能,不能影响桌宠正常启动/运行。

import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface PetConfig {
  /** 悬浮窗左上角屏幕坐标(拖拽放置后持久化,下次启动还原位置)。 */
  x?: number;
  y?: number;
  /** 当前皮肤 id;'default' 或未设置均表示使用 assets/mascot.svg。 */
  skinId?: string;
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'pet-config.json');
}

/** 读取持久化配置;文件不存在/内容非法均返回 {}(全部走默认值)。 */
export function loadConfig(): PetConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return {};
    const raw = readFileSync(p, 'utf8');
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return {};
    const o = obj as Record<string, unknown>;
    const cfg: PetConfig = {};
    if (typeof o.x === 'number') cfg.x = o.x;
    if (typeof o.y === 'number') cfg.y = o.y;
    if (typeof o.skinId === 'string') cfg.skinId = o.skinId;
    return cfg;
  } catch {
    return {};
  }
}

/** 合并写入持久化配置(浅合并;patch 里的字段覆盖旧值,未提供的字段保留)。 */
export function saveConfig(patch: Partial<PetConfig>): void {
  try {
    const next = { ...loadConfig(), ...patch };
    writeFileSync(configPath(), JSON.stringify(next), 'utf8');
  } catch {
    // 静默:持久化失败不影响当前运行,下次启动回退默认值
  }
}
