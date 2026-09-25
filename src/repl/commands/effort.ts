/**
 * 思考强度命令组:/effort [off|low|medium|high|auto](#token-efficiency P3)
 *
 * 无参弹选择菜单(promptIntervention);带参直设;auto = 不下发任何 reasoning 参数。
 * 生效链路:updateModelConfig 改内存/env + 会话 pin 同步 → writeConfigKeys 持久化 →
 * refreshStatusBase 刷底栏。不需要 reconfigureClient(effort 在每次请求体现读)。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { config, updateModelConfig } from '../../config/index.js';
import { writeConfigKeys } from '../../config/file.js';
import { promptIntervention } from '../../ui/intervention.js';
import { parseReasoningEffort, recognizesReasoning, type ReasoningEffort } from '../../llm/reasoning.js';
import { unhandled, next, type CommandHandler } from './types.js';

const LEVELS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'auto'];
const LEVEL_LABELS: Record<ReasoningEffort, string> = {
  off: 'off(关闭思考)',
  low: 'low(少思考·快·省)',
  medium: 'medium(均衡)',
  high: 'high(深度思考)',
  auto: 'auto(不下发,后端默认)',
};

/** 当前目标模型是否在白名单内(未识别则给提示)。 */
function currentModelRecognized(): boolean {
  return recognizesReasoning({
    provider: config.provider === 'anthropic' ? 'anthropic' : 'openai',
    model: config.model,
    maxTokens: config.maxTokens,
  });
}

export const effortCommands: CommandHandler[] = [
  async (ctx) => {
    const { line } = ctx;
    if (line !== '/effort' && !line.startsWith('/effort ')) return unhandled();
    const arg = line.startsWith('/effort ') ? line.slice('/effort '.length).trim() : '';

    let effort: ReasoningEffort | undefined;
    if (arg === '') {
      // 无参:弹菜单,预选项为当前档。
      let res;
      try {
        res = await promptIntervention({
          type: 'choice',
          title: '选择思考强度(reasoning effort)',
          detail: '同档名在不同模型上语义不完全等价;未知模型/第三方网关不下发参数。' + `当前:${getActiveEffortLabel()}`,
          options: LEVELS.map((lv) => LEVEL_LABELS[lv]),
        });
      } catch {
        return next(); // Ctrl+C
      }
      if (res.action === 'cancelled') return next();
      if (!res.value) return next();
      const idx = LEVELS.map((lv) => LEVEL_LABELS[lv]).indexOf(res.value);
      if (idx === -1) return next();
      effort = LEVELS[idx];
    } else {
      effort = parseReasoningEffort(arg);
      if (!effort) {
        layout.contentWrite(`${ui.yellow}未知思考强度: ${arg};可选 off | low | medium | high | auto${ui.reset}\n`);
        return next();
      }
    }

    updateModelConfig({ reasoningEffort: effort });
    writeConfigKeys({ REASONING_EFFORT: effort });
    ctx.refreshStatusBase(ctx.history);
    layout.contentWrite(`${ui.dim}思考强度已设为 ${LEVEL_LABELS[effort]}${ui.reset}\n`);
    if (effort !== 'auto' && !currentModelRecognized()) {
      layout.contentWrite(
        `${ui.yellow}(当前模型未识别为支持 reasoning 参数,设置不会下发;切换到 o/gpt-5/Qwen3/GLM-4.5+/Claude 等模型后生效)${ui.reset}\n`,
      );
    }
    return next();
  },
];

/** 读当前会话 effort 的展示标签(模块内辅助)。 */
function getActiveEffortLabel(): string {
  return LEVEL_LABELS[config.reasoningEffort];
}
