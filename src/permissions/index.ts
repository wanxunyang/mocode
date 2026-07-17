import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Tool, ToolRisk } from '../tools/types.js';
import { promptIntervention } from '../ui/intervention.js';
import { config } from '../config/index.js';
import { t } from '../i18n/index.js';

/**
 * 工具权限系统:基于 risk 字段在执行前拦截确认。
 * 
 * 设计:
 *  - safe      → 直接放行(只读工具,零交互)
 *  - confirm   → 弹面板确认,同工具同会话缓存(避免重复打断)
 *  - dangerous → 每次都弹(高风险,命令内容不可预测)
 * 
 * 三层允许(优先级从高到低):
 *  1. 永久允许(permanentAllow,跨会话持久化到 ~/.mocode/permissions.json)
 *  2. 会话允许(approvedTools,本次进程内缓存)
 *  3. 面板询问(promptIntervention,复用 ask_human UI)
 * 
 * 复用 promptIntervention:统一 UI 面板,非 TTY 自动降级(第一项 = 允许)。
 */

/** 跨会话持久化允许列表路径 */
const PERMISSIONS_PATH = path.join(os.homedir(), '.mocode', 'permissions.json');

/** 永久允许:跨会话持久化(用户选了"以后不再询问此工具") */
let permanentAllow: Set<string> = new Set();
let permanentLoaded = false;

/** 会话级缓存:confirm 级工具批准后,后续调用不再弹 */
const approvedTools = new Set<string>();

/** 从磁盘加载永久允许列表(首调时触发,之后用内存缓存;文件不存在/解析失败返空集合) */
function loadPermanent(): Set<string> {
  if (permanentLoaded) return permanentAllow;
  permanentLoaded = true;
  try {
    const raw = fs.readFileSync(PERMISSIONS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.allowForever)) {
      permanentAllow = new Set(parsed.allowForever.filter((x: unknown) => typeof x === 'string'));
    }
  } catch {
    // 文件不存在 / 解析失败 → 空集合(不阻断,用户首次使用或配置损坏均安全降级)
  }
  return permanentAllow;
}

/** 写入永久允许列表(覆盖写;失败静默,下次启动丢失但不阻断当前会话) */
function savePermanent(): void {
  try {
    fs.mkdirSync(path.dirname(PERMISSIONS_PATH), { recursive: true });
    fs.writeFileSync(
      PERMISSIONS_PATH,
      JSON.stringify({ allowForever: Array.from(permanentAllow) }, null, 2) + '\n',
      'utf8'
    );
  } catch {
    // 写失败静默(与 updateConfigKey 一致:UI 偏好路径,不阻断 REPL)
  }
}

/** 从 Tool 解析 risk,缺省返 'safe'(只读工具无需标注)。 */
export function getToolRisk(tool: Tool): ToolRisk {
  return tool.risk ?? 'safe';
}

/** 参数摘要:提取关键参数供确认面板展示(path / command 等)。 */
function summarizeArgs(tool: Tool, args: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof args.path === 'string') lines.push(t('permission.path', { value: args.path }));
  if (typeof args.command === 'string') lines.push(t('permission.command', { value: args.command }));
  if (typeof args.prompt === 'string') {
    const preview = String(args.prompt).slice(0, 100);
    lines.push(t('permission.task', { value: `${preview}${String(args.prompt).length > 100 ? '…' : ''}` }));
  }
  return lines.length > 0 ? lines.join('\n') : t('permission.noArgs');
}

/**
 * 检查权限:safe 直接放行;confirm/dangerous 弹面板让用户确认。
 * 
 * 返回 'allow' = 放行, 'deny' = 拒绝(不执行,也不记回滚快照)。
 * 非 TTY 环境(promptIntervention 内部处理):自动选第一项(允许)并打 stderr 日志,不阻塞。
 */
export async function checkPermission(
  tool: Tool,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<'allow' | 'deny'> {
  // 总开关关闭 → 全部放行(零行为变化,向后兼容)
  if (!config.permissionEnabled) return 'allow';

  const risk = getToolRisk(tool);
  if (risk === 'safe') return 'allow';

  // 永久允许(跨会话):命中则放行,不弹面板
  if (loadPermanent().has(tool.name)) return 'allow';

  // 会话允许(confirm 级):同进程内缓存,命中则放行
  if (risk === 'confirm' && approvedTools.has(tool.name)) return 'allow';

  // 构建确认面板
  const isDangerous = risk === 'dangerous';
  const denyOption = t('permission.deny');
  const foreverOption = t('permission.allowForever');
  const sessionOption = t('permission.allowSession');
  const title = isDangerous
    ? t('permission.dangerTitle', { tool: tool.name })
    : t('permission.confirmTitle', { tool: tool.name });
  const detail = summarizeArgs(tool, args) + (isDangerous ? `\n\n${t('permission.dangerWarning')}` : '');
  // 选项统一结构:dangerous 也提供"以后不再询问"(用户明确授权即尊重,即使 run_command)
  const options = isDangerous
    ? [t('permission.confirmExecute'), foreverOption, denyOption]
    : [t('permission.allow'), sessionOption, foreverOption, denyOption];

  // 弹面板(阻塞直到用户选择;signal 中断时 promptIntervention 内部处理)
  const result = await promptIntervention({
    type: 'choice',
    title,
    detail,
    options,
    allowCustom: false,
  });

  // 用户取消(Esc / Ctrl+C)→ 拒绝
  if (result.action === 'cancelled') return 'deny';

  // 解析选择
  const value = result.value ?? '';
  if (value === denyOption) return 'deny';

  // 永久允许:写入磁盘 + 加入内存集合(跨会话生效)
  if (value === foreverOption) {
    permanentAllow.add(tool.name);
    savePermanent();
    return 'allow';
  }

  // 会话允许(confirm 级):加入内存缓存,本次进程内不再弹
  if (!isDangerous && value === sessionOption) {
    approvedTools.add(tool.name);
  }

  return 'allow';
}

/** 移除工具的永久允许(撤销"以后不再询问"授权)。供未来 `/permissions` 管理命令使用。 */
export function revokePermanentAllow(toolName: string): void {
  if (permanentAllow.has(toolName)) {
    permanentAllow.delete(toolName);
    savePermanent();
  }
}

/** 列出所有永久允许的工具名(供未来 `/permissions` 管理命令使用)。 */
export function listPermanentAllow(): string[] {
  return Array.from(loadPermanent());
}
