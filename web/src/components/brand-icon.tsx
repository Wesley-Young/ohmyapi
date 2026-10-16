import { HStack, type StackProps } from '@chakra-ui/react';
// Deep imports keep the SVG components only: the package entry and its Avatar/Combine
// variants pull in antd and @lobehub/ui.
import Antigravity from '@lobehub/icons/es/Antigravity/components/Color.js';
import Baichuan from '@lobehub/icons/es/Baichuan/components/Color.js';
import ByteDance from '@lobehub/icons/es/ByteDance/components/Color.js';
import Claude from '@lobehub/icons/es/Claude/components/Color.js';
import Cohere from '@lobehub/icons/es/Cohere/components/Color.js';
import DeepSeek from '@lobehub/icons/es/DeepSeek/components/Color.js';
import Doubao from '@lobehub/icons/es/Doubao/components/Color.js';
import Gemini from '@lobehub/icons/es/Gemini/components/Color.js';
import Gemma from '@lobehub/icons/es/Gemma/components/Color.js';
import Grok from '@lobehub/icons/es/Grok/components/Mono.js';
import Hunyuan from '@lobehub/icons/es/Hunyuan/components/Color.js';
import Kimi from '@lobehub/icons/es/Kimi/components/Color.js';
import LongCat from '@lobehub/icons/es/LongCat/components/Color.js';
import Meta from '@lobehub/icons/es/Meta/components/Color.js';
import Microsoft from '@lobehub/icons/es/Microsoft/components/Color.js';
import Minimax from '@lobehub/icons/es/Minimax/components/Color.js';
import Mistral from '@lobehub/icons/es/Mistral/components/Color.js';
import Nvidia from '@lobehub/icons/es/Nvidia/components/Color.js';
import OpenAI from '@lobehub/icons/es/OpenAI/components/Mono.js';
import Perplexity from '@lobehub/icons/es/Perplexity/components/Color.js';
import Qwen from '@lobehub/icons/es/Qwen/components/Color.js';
import Stepfun from '@lobehub/icons/es/Stepfun/components/Mono.js';
import Wenxin from '@lobehub/icons/es/Wenxin/components/Color.js';
import XiaomiMiMo from '@lobehub/icons/es/XiaomiMiMo/components/Mono.js';
import Yi from '@lobehub/icons/es/Yi/components/Color.js';
import Zhipu from '@lobehub/icons/es/Zhipu/components/Color.js';

import type { SubscriptionProvider } from '../lib/subscription';

type Icon = typeof OpenAI;

/** 按模型名匹配厂商，先匹配的优先（如 `deepseek-r1-distill-qwen` 归 DeepSeek）。 */
const modelBrands: [RegExp, Icon][] = [
  [/deepseek/, DeepSeek],
  [/gpt|(^|\/)o[134](-|$)|dall-?e|sora|codex|whisper|(^|\/)tts-|text-embedding|openai/, OpenAI],
  [/claude/, Claude],
  [/gemma/, Gemma],
  [/gemini|nano-?banana/, Gemini],
  [/qwen|qwq|qvq|tongyi|wanx/, Qwen],
  [/kimi|moonshot/, Kimi],
  [/(^|[/-])glm|chatglm|codegeex/, Zhipu],
  [/minimax|abab/, Minimax],
  [/mistral|mixtral|codestral|ministral|magistral|devstral|pixtral|voxtral/, Mistral],
  [/llama|(^|\/)muse-/, Meta],
  [/grok/, Grok],
  [/doubao/, Doubao],
  [/(^|\/)seed|bytedance/, ByteDance],
  [/hunyuan/, Hunyuan],
  [/ernie/, Wenxin],
  [/cohere|(^|\/)command-|(^|\/)aya-/, Cohere],
  [/sonar|pplx/, Perplexity],
  [/(^|[/-])yi-/, Yi],
  [/(^|\/)step-?\d/, Stepfun],
  [/baichuan/, Baichuan],
  [/(^|[/-])phi-|microsoft/, Microsoft],
  [/nemotron|nvidia/, Nvidia],
  [/mimo/, XiaomiMiMo],
  [/longcat/, LongCat],
];

const providerIcons = {
  openai: OpenAI,
  claude: Claude,
  antigravity: Antigravity,
} satisfies Record<SubscriptionProvider, Icon>;

const matchModel = (model: string) => {
  const name = model.toLowerCase();
  return modelBrands.find(([pattern]) => pattern.test(name))?.[1];
};

/** 模型厂商图标；无法识别时不渲染。图标是装饰，名称由相邻文本提供。 */
export function ModelIcon({ model, size = 16 }: { model: string; size?: number }) {
  const Icon = matchModel(model);
  return Icon ? <Icon size={size} aria-hidden focusable="false" style={{ flexShrink: 0 }} /> : null;
}

/** 订阅平台图标。 */
export function ProviderIcon({ provider, size = 16 }: { provider: SubscriptionProvider; size?: number }) {
  const Icon = providerIcons[provider];
  return <Icon size={size} aria-hidden focusable="false" style={{ flexShrink: 0 }} />;
}

/** 图标与模型名并排；`children` 缺省时显示模型名。 */
export function ModelLabel({ model, size, children, ...props }: { model: string; size?: number } & StackProps) {
  return (
    <HStack as="span" display="inline-flex" gap="1.5" minW="0" verticalAlign="middle" {...props}>
      <ModelIcon model={model} size={size} />
      <span>{children ?? model}</span>
    </HStack>
  );
}
