/**
 * 各档思考预算（#model-catalog M3）。
 *
 * 独立小模块：reasoning.ts 与 reasoning-cap.ts 都要用，放在 models 下可避免
 * reasoning-cap → reasoning 的反向依赖（reasoning 会 import reasoning-cap）。
 */
export const THINK_BUDGET_BY_EFFORT: Record<'low' | 'medium' | 'high', number> = {
  low: 1024,
  medium: 4096,
  high: 10240,
};
