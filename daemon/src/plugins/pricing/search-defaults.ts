import { parseMoney } from '../../core/money.ts';
import type { Rule } from './rules.ts';

/** GPT-5/6 搜索调用单价按每千次；USD/CNY 仅作为显示符号。
 * 定价来源：https://developers.openai.com/api/docs/pricing
 */
export function defaultSearchPrices(modelName: string) {
  const name = modelName.toLowerCase().replace(/^openai\//, '');
  if (!/^gpt-[56](?:[.-]|$)/.test(name)) return { webSearchPrice: null, webSearchPreviewPrice: null };
  return { webSearchPrice: '10.000000', webSearchPreviewPrice: '10.000000' };
}

export function applySearchDefaults<T extends Rule>(rule: T, modelName: string): T {
  const defaults = defaultSearchPrices(modelName);
  return {
    ...rule,
    webSearchPriceMicros:
      rule.webSearchPriceMicros ?? (defaults.webSearchPrice === null ? null : parseMoney(defaults.webSearchPrice)),
    webSearchPreviewPriceMicros:
      rule.webSearchPreviewPriceMicros ??
      (defaults.webSearchPreviewPrice === null ? null : parseMoney(defaults.webSearchPreviewPrice)),
  };
}
