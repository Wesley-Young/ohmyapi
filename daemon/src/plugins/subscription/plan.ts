/** 订阅套餐只缓存在内存中；值为 null 表示已查询但上游未提供。 */
export type PlanCache = Map<string, string | null>;

/** 保留上游原始套餐标识，仅接受短小的安全字符，展示名称由前端映射。 */
export function planValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const plan = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(plan) ? plan : null;
}
