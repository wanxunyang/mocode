/**
 * 模型目录命令（#model-catalog，兼容入口）：/model browse · /model catalog [refresh]
 *
 * 交互逻辑已抽到 model-actions.ts，统一模型面板（裸 /model）与这里共用同一套动作。
 * 本文件只保留命令路由与目录无参查看。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { promptIntervention } from '../../ui/intervention.js';
import { loadCatalog } from '../../models/catalog.js';
import { searchModels } from '../../models/search.js';
import { addCatalogModel, refreshAndReport } from './model-actions.js';
import { unhandled, next, type CommandContext, type CommandHandler } from './types.js';

/** 一次 browse 列表上限（统一面板可滚动更多；此兼容入口保持收窄）。 */
const MAX_BROWSE = 30;

export const modelCatalogCommands: CommandHandler[] = [
  async (ctx: CommandContext) => {
    const { line } = ctx;
    if (line === '/model browse' || line.startsWith('/model browse ')) {
      const cat = await loadCatalog();
      if (cat.source === 'empty' || Object.keys(cat.providers).length === 0) {
        layout.contentWrite(
          `${ui.yellow}暂无模型目录且离线：联网后 /model catalog refresh，或用 /model 配置。${ui.reset}\n`,
        );
        return next();
      }
      // 兼容 browse：先输入关键字，再从收窄结果里选（添加动作与统一面板一致）。
      const qres = await promptIntervention({
        type: 'input',
        title: '搜索模型',
        detail: '输入厂商/模型关键字（glm、qwen、claude、doubao…），回车列出。',
        seed: '',
      });
      if (qres.action === 'cancelled') return next();
      const query = (qres.value ?? '').trim();
      const results = searchModels(cat.providers, { query }).slice(0, MAX_BROWSE);
      if (results.length === 0) {
        layout.contentWrite(`${ui.yellow}没有匹配 “${query}” 的可直发模型。${ui.reset}\n`);
        return next();
      }
      const sel = await promptIntervention({
        type: 'choice',
        title: `选择模型（${results.length}）`,
        options: results.map((e) => e.model.name || e.modelId),
        allowCustom: false,
      });
      if (sel.action === 'cancelled') return next();
      const picked = results.find((e) => (e.model.name || e.modelId) === sel.value);
      if (picked) await addCatalogModel(ctx, picked, cat.providers);
      return next();
    }

    if (line === '/model catalog' || line === '/model catalog refresh') {
      if (line === '/model catalog refresh') await refreshAndReport();
      else {
        const cat = await loadCatalog();
        const n = Object.values(cat.providers).reduce((acc, p) => acc + Object.keys(p.models ?? {}).length, 0);
        layout.contentWrite(
          cat.source === 'empty'
            ? `${ui.yellow}本地无目录：/model catalog refresh 拉取。${ui.reset}\n`
            : `${ui.dim}目录（${cat.source === 'live' ? '在线' : '快照'}）：${Object.keys(cat.providers).length} 厂商 / ${n} 模型（${cat.fetchedAt?.slice(0, 10)}）${ui.reset}\n`,
        );
      }
      return next();
    }

    return unhandled();
  },
];
