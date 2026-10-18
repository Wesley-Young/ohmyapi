/**
 * 按字符类别粗略估算 Token，以四分之一 Token 为单位：ASCII 记 1，CJK、假名、谚文和全角字符记 4，
 * 其他字符记 2（代理对的两个码元合计 4）。不对应任何模型的分词器，只用于客户端断连时估算未报告的输出。
 */
function textUnits(text: string) {
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    units +=
      c < 0x80
        ? 1
        : (c >= 0x2e80 && c <= 0x9fff) ||
            (c >= 0xac00 && c <= 0xd7af) ||
            (c >= 0xf900 && c <= 0xfaff) ||
            (c >= 0xff00 && c <= 0xffef)
          ? 4
          : 2;
  }
  return units;
}

const unitsToTokens = (units: number) => Math.ceil(units / 4);

/** 估算方法的标识，随断连估算一起保存。 */
export const tokenEstimateMethod = 'char_class_v1';

/** 累计流式输出的字符单位；按字符计数与 SSE 分片边界无关。 */
export class OutputTokenEstimate {
  private units = 0;

  append(value: unknown) {
    if (typeof value === 'string' && value) this.units += textUnits(value);
  }

  /** 已观察内容的估算 Token 数。 */
  count() {
    return BigInt(unitsToTokens(this.units));
  }

  reset() {
    this.units = 0;
  }
}
