import { Box, HStack, type StackProps } from '@chakra-ui/react';
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

import { type ModelBrand, modelBrand } from '../lib/model-brands';
import type { SubscriptionProvider } from '../lib/subscription';

type Icon = typeof OpenAI;

const modelIcons = {
  deepseek: DeepSeek,
  openai: OpenAI,
  claude: Claude,
  gemma: Gemma,
  gemini: Gemini,
  qwen: Qwen,
  kimi: Kimi,
  zhipu: Zhipu,
  minimax: Minimax,
  mistral: Mistral,
  meta: Meta,
  grok: Grok,
  doubao: Doubao,
  bytedance: ByteDance,
  hunyuan: Hunyuan,
  wenxin: Wenxin,
  cohere: Cohere,
  perplexity: Perplexity,
  yi: Yi,
  stepfun: Stepfun,
  baichuan: Baichuan,
  microsoft: Microsoft,
  nvidia: Nvidia,
  mimo: XiaomiMiMo,
  longcat: LongCat,
} satisfies Record<ModelBrand, Icon>;

/** 图标主色为白色，需要黑色底才能在浅色背景中看清的厂商。 */
const darkBackedBrands: ReadonlySet<ModelBrand> = new Set<ModelBrand>(['kimi']);

const providerIcons = {
  openai: OpenAI,
  claude: Claude,
  antigravity: Antigravity,
} satisfies Record<SubscriptionProvider, Icon>;

/** 模型厂商图标；无法识别时不渲染。图标是装饰，名称由相邻文本提供。 */
export function ModelIcon({ model, size = 16 }: { model: string; size?: number }) {
  const brand = modelBrand(model);
  const Icon = brand && modelIcons[brand];
  if (!Icon) return null;
  if (brand && darkBackedBrands.has(brand)) {
    // 主色为白色的图标放在黑色圆角底上，避免在白色背景中不可见。
    const inset = Math.round(size * 0.14);
    return (
      <Box
        as="span"
        display="inline-flex"
        alignItems="center"
        justifyContent="center"
        flexShrink="0"
        bg="black"
        style={{ width: size, height: size, padding: inset, borderRadius: Math.round(size * 0.25) }}
        // 按钮等组件会按自己的尺寸缩放内部 svg，这里固定图标尺寸，避免撑出黑色底。
        css={{ '& > svg': { width: `${size - inset * 2}px`, height: `${size - inset * 2}px` } }}
      >
        <Icon size={size - inset * 2} aria-hidden focusable="false" />
      </Box>
    );
  }
  return <Icon size={size} aria-hidden focusable="false" style={{ flexShrink: 0 }} />;
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
