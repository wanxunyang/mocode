/**
 * 图片附件命令组:/image · /image list · /image clear · /image &lt;path&gt;
 *
 * 单 handler 内部按完整 line 分流,顺序与原 if 链一致:
 * 先 list/clear(完整匹配),再落到 &lt;path&gt; 分支。
 *
 * dispatch 阶段**不调 runTurn**:仅 mutate ctx.attachments 状态,
 * 提交时(runTurn 入口)才 flush 进 history。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { config } from '../../config/index.js';
import { loadImageAttachment, renderChip, MAX_INLINE_BYTES_DEFAULT } from '../../attachments/image.js';
import { modelSupportsVision } from '../../llm/capabilities.js';
import { unhandled, next, type CommandHandler } from './types.js';

export const imageCommands: CommandHandler[] = [
  async (ctx) => {
    const { line } = ctx;
    const isImage =
      line === '/image' || line === '/image list' || line === '/image clear' || line.startsWith('/image ');
    if (!isImage) return unhandled();
    const pending = ctx.attachments.list();

    if (line === '/image list' || (line === '/image' && pending.length > 0)) {
      // 空 /image 视为 list(无歧义;若用户想加图必须 /image <path>)
      if (pending.length === 0) {
        layout.contentWrite(`${ui.dim}(无待发送图片)${ui.reset}\n`);
      } else {
        for (const a of pending) {
          layout.contentWrite(`  ${ui.dim}${renderChip(a)}${ui.reset}\n`);
        }
      }
      return next();
    }
    if (line === '/image clear' || (line === '/image' && pending.length === 0)) {
      // /image 单独输入 + 无 pending:也走 list(空集)
      if (line === '/image' && pending.length === 0) {
        layout.contentWrite(`${ui.dim}(无待发送图片)${ui.reset}\n`);
      } else {
        ctx.attachments.clear();
        layout.contentWrite(`${ui.dim}(已清空待发送图片)${ui.reset}\n`);
      }
      return next();
    }
    const arg = line.slice('/image'.length).trim().replace(/^["']|["']$/g, '');
    if (!arg) {
      layout.contentWrite(`${ui.dim}用法: /image <path>${ui.reset}\n`);
      return next();
    }
    const maxBytes = config.maxImageBytes ?? MAX_INLINE_BYTES_DEFAULT;
    const r = await loadImageAttachment(arg, { maxBytes });
    if (!r.ok) {
      layout.contentWrite(`${ui.red}[image] ${r.reason}${ui.reset}\n`);
      return next();
    }
    if (!ctx.attachments.list().find((a) => a.id === r.att.id)) {
      ctx.attachments.push(r.att);
    }
    layout.contentWrite(`  ${ui.dim}${renderChip(r.att)} — will attach to next message${ui.reset}\n`);
    // 提前警告(不阻断附加):当前模型已知不支持视觉(如 MiniMax M2.x / gpt-3.5 等)时,
    // 附加时就提示,而不是等发送后才在 catch 块里翻译 API 报错——减少一轮无意义请求。
    if (!modelSupportsVision(config.model)) {
      layout.contentWrite(
        `  ${ui.yellow}⚠ 当前模型 ${config.model} 已知不支持视觉输入,发送图片可能会失败。可用 /model 切换。${ui.reset}\n`,
      );
    }
    return next();
  },
];
