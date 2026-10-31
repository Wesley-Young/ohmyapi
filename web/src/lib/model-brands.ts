/** 按模型名识别厂商，先匹配的优先（如 `deepseek-r1-distill-qwen` 归 DeepSeek）。 */
const brands = [
  { id: 'deepseek', label: 'DeepSeek', pattern: /deepseek/ },
  {
    id: 'openai',
    label: 'OpenAI',
    pattern: /gpt|(^|\/)o[134](-|$)|dall-?e|sora|codex|whisper|(^|\/)tts-|text-embedding|openai/,
  },
  { id: 'claude', label: 'Claude', pattern: /claude/ },
  { id: 'gemma', label: 'Gemma', pattern: /gemma/ },
  { id: 'gemini', label: 'Gemini', pattern: /gemini|nano-?banana/ },
  { id: 'qwen', label: 'Qwen', pattern: /qwen|qwq|qvq|tongyi|wanx/ },
  { id: 'kimi', label: 'Kimi', pattern: /kimi|moonshot/ },
  { id: 'zhipu', label: '智谱', pattern: /(^|[/-])glm|chatglm|codegeex/ },
  { id: 'minimax', label: 'MiniMax', pattern: /minimax|abab/ },
  {
    id: 'mistral',
    label: 'Mistral',
    pattern: /mistral|mixtral|codestral|ministral|magistral|devstral|pixtral|voxtral/,
  },
  { id: 'meta', label: 'Meta', pattern: /llama|(^|\/)muse-/ },
  { id: 'grok', label: 'Grok', pattern: /grok/ },
  { id: 'doubao', label: '豆包', pattern: /doubao/ },
  { id: 'bytedance', label: '字节跳动', pattern: /(^|\/)seed|bytedance/ },
  { id: 'hunyuan', label: '混元', pattern: /hunyuan/ },
  { id: 'wenxin', label: '文心', pattern: /ernie/ },
  { id: 'cohere', label: 'Cohere', pattern: /cohere|(^|\/)command-|(^|\/)aya-/ },
  { id: 'perplexity', label: 'Perplexity', pattern: /sonar|pplx/ },
  { id: 'yi', label: '零一万物', pattern: /(^|[/-])yi-/ },
  { id: 'stepfun', label: '阶跃星辰', pattern: /(^|\/)step-?\d/ },
  { id: 'baichuan', label: '百川', pattern: /baichuan/ },
  { id: 'microsoft', label: 'Microsoft', pattern: /(^|[/-])phi-|microsoft/ },
  { id: 'nvidia', label: 'NVIDIA', pattern: /nemotron|nvidia/ },
  { id: 'mimo', label: 'MiMo', pattern: /mimo/ },
  { id: 'longcat', label: 'LongCat', pattern: /longcat/ },
] as const;

export type ModelBrand = (typeof brands)[number]['id'];

/** 厂商筛选值：具体厂商，或 `other` 表示无法识别。 */
export type BrandFilter = ModelBrand | 'other';

const brandLabels = Object.fromEntries(brands.map((brand) => [brand.id, brand.label])) as Record<ModelBrand, string>;

export function modelBrand(model: string): ModelBrand | undefined {
  const name = model.toLowerCase();
  return brands.find((brand) => brand.pattern.test(name))?.id;
}

const brandFilterLabel = (filter: BrandFilter) => (filter === 'other' ? '其他' : brandLabels[filter]);

/** 模型所属厂商的名称，无法识别时为「其他」。 */
export const modelBrandLabel = (model: string) => brandFilterLabel(modelBrand(model) ?? 'other');

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/** 先按厂商名、再按模型名排序；无法识别厂商的模型排在最后。 */
export function sortModelsByBrand<T extends { name: string }>(models: readonly T[]): T[] {
  return models
    .map((model) => ({ model, brand: modelBrand(model.name) }))
    .sort(
      (a, b) =>
        Number(!a.brand) - Number(!b.brand) ||
        (a.brand && b.brand ? collator.compare(brandLabels[a.brand], brandLabels[b.brand]) : 0) ||
        collator.compare(a.model.name, b.model.name),
    )
    .map(({ model }) => model);
}

/** 列表中出现的厂商，顺序与 `sortModelsByBrand` 一致。 */
export function brandOptions(models: readonly { name: string }[]): { id: BrandFilter; name: string }[] {
  const present = new Set<BrandFilter>(models.map((model) => modelBrand(model.name) ?? 'other'));
  return [...present]
    .sort(
      (a, b) =>
        Number(a === 'other') - Number(b === 'other') || collator.compare(brandFilterLabel(a), brandFilterLabel(b)),
    )
    .map((id) => ({ id, name: brandFilterLabel(id) }));
}

/** 按模型名关键字和厂商筛选；空条件不过滤。 */
export function filterModels<T extends { name: string }>(
  models: readonly T[],
  { search, brand }: { search: string; brand: BrandFilter | '' },
): T[] {
  const term = search.trim().toLowerCase();
  return models.filter(
    (model) =>
      (!term || model.name.toLowerCase().includes(term)) && (!brand || (modelBrand(model.name) ?? 'other') === brand),
  );
}
