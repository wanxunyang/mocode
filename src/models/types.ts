/**
 * models.dev 目录的最小类型（#model-catalog）。
 *
 * 只声明 mocode 实际消费的字段——上游 api.json 一个 provider 下还有很多我们用不到的
 * 字段，刻意不照搬，保持类型面小、上游增字段不影响编译。所有字段按「可能缺失」处理，
 * 消费方走默认值，不假设上游永远规整。
 */

/** 思考控制形态：models.dev reasoning_options[].type 实测三类。 */
export type CatalogReasoningType = 'toggle' | 'effort' | 'budget_tokens';

export interface CatalogReasoningOption {
  type: CatalogReasoningType;
  /** type='effort' 时的合法档位，如 ['low','medium','high'] / ['low','high','max']。 */
  values?: string[];
  /** type='budget_tokens' 时的预算下界。 */
  min?: number;
}

export interface CatalogModelLimit {
  context?: number;
  input?: number;
  output?: number;
}

export interface CatalogModelCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface CatalogModalities {
  input?: string[];
  output?: string[];
}

export interface CatalogModel {
  id: string;
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: CatalogReasoningOption[];
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  modalities?: CatalogModalities;
  limit?: CatalogModelLimit;
  cost?: CatalogModelCost;
  open_weights?: boolean;
  release_date?: string;
  last_updated?: string;
}

export interface CatalogProvider {
  id: string;
  name?: string;
  /** Vercel AI SDK 包名；mocode 用它判定协议（见 protocol.ts），不真的加载这些包。 */
  npm?: string;
  /** OpenAI 兼容端点；部分 provider（官方 openai/google 等）无此字段。 */
  api?: string;
  /** 认可的 key 环境变量名列表，如 ['ZHIPU_API_KEY']。 */
  env?: string[];
  doc?: string;
  models: Record<string, CatalogModel>;
}

/** 落盘快照结构：~/.mocode/catalog.json。 */
export interface CatalogSnapshot {
  fetchedAt: string;
  etag?: string;
  providers: Record<string, CatalogProvider>;
}

/** 加载结果：携带数据来源信息，便于 UI 标注在线/离线。 */
export interface LoadedCatalog {
  providers: Record<string, CatalogProvider>;
  /** 'live' 新拉取成功；'cache' 用了本地快照；'empty' 无任何数据。 */
  source: 'live' | 'cache' | 'empty';
  fetchedAt?: string;
  etag?: string;
}
