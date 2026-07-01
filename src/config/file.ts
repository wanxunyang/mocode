import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * ~/.mocode/config 全局 dotenv 配置的读写叶子(纯 node:fs / node:os / node:path + dotenv)。
 *
 * 独立于 `config/index.ts`——**不**触发 requireEnv / process.exit,故 `commands/config.ts`
 * (首跑向导,刻意不 import config/index.ts)与 `repl/index.ts`(`/theme` 持久化)都能安全共享。
 * 主题等 UI 偏好走 `updateConfigKey` 单键写;向导多键一次性写走 `writeConfigKeys`。
 */

/** ~/.mocode/config:全局配置(与 ~/.mocode/skills 同目录,任意终端 / 任意目录生效)。 */
export const CONFIG_PATH = path.join(os.homedir(), '.mocode', 'config');

/** 读已有配置(没有则空对象),用于回填默认值与保留其它键。 */
export function readConfigFile(): Record<string, string> {
  try {
    return dotenv.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 读-合并-写:把 entries 覆盖进 ~/.mocode/config,保留文件里其它键。
 * mkdirSync 兜底(首跑无 ~/.mocode)。不吞 I/O 异常——向导路径让其抛(与历史行为一致);
 * UI 偏好路径用 `updateConfigKey`(自带 try/catch 静默)。
 */
export function writeConfigKeys(entries: Record<string, string>): void {
  const merged: Record<string, string> = { ...readConfigFile(), ...entries };
  const body = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${body}\n`, 'utf8');
}

/**
 * 单键持久化(主题等 UI 偏好):写失败静默——下次启动读不到则回退默认,不阻断 REPL。
 * 注意:shell env 设了同名键时,`config/index.ts` 的 loadEnvFiles 只 backfill undefined 的
 * process.env,故文件写对**下次启动**可能被 shell 盖——调用方据此给 dim 警告。
 */
export function updateConfigKey(key: string, value: string): void {
  try {
    writeConfigKeys({ [key]: value });
  } catch {
    // 写失败不阻断(UI 偏好)
  }
}
