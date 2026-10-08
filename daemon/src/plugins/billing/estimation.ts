import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

// A local approximation for arbitrary upstream models, not a billing tokenizer.
const tokenizer = new Tiktoken(o200kBase);
export type ReservationEstimate = {
  inputTokens: number;
  outputTokens: number;
  inputContentTokens: number;
  outputHistorySamples: number;
  outputBaselineTokens: string;
  outputSource: 'recent_usage' | 'fallback';
};
const margin = (tokens: bigint) => (tokens * 5n + 3n) / 4n + 256n;
const capped = (tokens: bigint, limit: number) => Number(tokens > BigInt(limit) ? BigInt(limit) : tokens);

export function estimateReservation(
  body: Record<string, unknown>,
  outputLimit: number,
  recentOutputTokens: bigint[],
): ReservationEstimate {
  // Include message wrappers, tool schemas and instructions. Treat special-token-looking text literally.
  const text = JSON.stringify(body);
  let inputContentTokens = 0;
  // Bound each BPE operation even for long strings without whitespace.
  for (let offset = 0; offset < text.length; offset += 4096)
    inputContentTokens += tokenizer.encode(text.slice(offset, offset + 4096), [], []).length;
  const samples = recentOutputTokens.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const useHistory = samples.length >= 5;
  const baseline = useHistory ? samples[Math.ceil(samples.length * 0.95) - 1] : 4096n;
  const paddedOutput = useHistory ? margin(baseline) : baseline;
  const outputTokens = paddedOutput < 512n ? 512n : paddedOutput;
  return {
    // 模型上下文容量独立于计费预估，预占覆盖完整输入和估算余量。
    inputTokens: Number(margin(BigInt(inputContentTokens))),
    outputTokens: capped(outputTokens, outputLimit),
    inputContentTokens,
    outputHistorySamples: samples.length,
    outputBaselineTokens: baseline.toString(),
    outputSource: useHistory ? 'recent_usage' : 'fallback',
  };
}
