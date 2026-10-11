// 对齐 CPA 54946fa3 的模型能力判断。未知模型沿用 CPA 的 mid-conversation system 默认值。
export const legacyModels = new Set([
  'claude-3-5-haiku-20241022',
  'claude-3-5-haiku-latest',
  'claude-3-7-sonnet-20250219',
  'claude-3-7-sonnet-latest',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4',
  'claude-opus-4-20250514',
  'claude-opus-4-1',
  'claude-opus-4-1-20250805',
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-sonnet-4',
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6',
]);
export const canonicalModel = (model: string) => model.trim().toLowerCase().split('/').at(-1) ?? model;
export const isLegacy = (model: string) => legacyModels.has(canonicalModel(model));
export const isFable = (model: string) => canonicalModel(model).startsWith('claude-fable-5-1');
export const isOpus55 = (model: string) => /^claude-opus-5-5(?:$|\[)/.test(canonicalModel(model));
export const isSonnet55 = (model: string) => /^claude-sonnet-5-5(?:$|[-[])/.test(canonicalModel(model));
export const isSonnet5 = (model: string) =>
  !isSonnet55(model) && /^claude-sonnet-5(?:$|[-[])/.test(canonicalModel(model));
export const progressDisplay = (model: string) =>
  isFable(model) || isOpus55(model) || isSonnet5(model) || isSonnet55(model);
