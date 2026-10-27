// Deep imports keep the SVG components only: the package entry and its Avatar/Combine
// variants pull in antd and @lobehub/ui.
import Baichuan from '@lobehub/icons/es/Baichuan/components/Color.js';
import Baidu from '@lobehub/icons/es/Baidu/components/Color.js';
import Claude from '@lobehub/icons/es/Claude/components/Color.js';
import Cohere from '@lobehub/icons/es/Cohere/components/Color.js';
import DeepSeek from '@lobehub/icons/es/DeepSeek/components/Color.js';
import Doubao from '@lobehub/icons/es/Doubao/components/Color.js';
import Gemini from '@lobehub/icons/es/Gemini/components/Color.js';
import Grok from '@lobehub/icons/es/Grok/components/Mono.js';
import Groq from '@lobehub/icons/es/Groq/components/Mono.js';
import Hunyuan from '@lobehub/icons/es/Hunyuan/components/Color.js';
import Meta from '@lobehub/icons/es/Meta/components/Color.js';
import MiniMax from '@lobehub/icons/es/Minimax/components/Color.js';
import Mistral from '@lobehub/icons/es/Mistral/components/Color.js';
import Moonshot from '@lobehub/icons/es/Moonshot/components/Mono.js';
import OpenAI from '@lobehub/icons/es/OpenAI/components/Mono.js';
import OpenRouter from '@lobehub/icons/es/OpenRouter/components/Color.js';
import Qwen from '@lobehub/icons/es/Qwen/components/Color.js';
import SiliconCloud from '@lobehub/icons/es/SiliconCloud/components/Color.js';
import Stepfun from '@lobehub/icons/es/Stepfun/components/Mono.js';
import Yi from '@lobehub/icons/es/Yi/components/Color.js';
import Zhipu from '@lobehub/icons/es/Zhipu/components/Color.js';

import type { OhmyswitchVendor } from '../lib/ohmyswitch';

type Icon = typeof OpenAI;

/** 与 ohmyswitch 供应商角标同一套图形。单色标用前景色，没有彩色版的厂商也如此。 */
const logos = {
  openai: OpenAI,
  anthropic: Claude,
  google: Gemini,
  deepseek: DeepSeek,
  qwen: Qwen,
  moonshot: Moonshot,
  zhipu: Zhipu,
  xai: Grok,
  mistral: Mistral,
  meta: Meta,
  groq: Groq,
  minimax: MiniMax,
  doubao: Doubao,
  hunyuan: Hunyuan,
  baidu: Baidu,
  openrouter: OpenRouter,
  siliconcloud: SiliconCloud,
  stepfun: Stepfun,
  cohere: Cohere,
  yi: Yi,
  baichuan: Baichuan,
} satisfies Record<OhmyswitchVendor, Icon>;

/** ohmyswitch 厂商图标。图标是装饰，名称由相邻文本提供。 */
export function VendorIcon({ vendor, size = 16 }: { vendor: OhmyswitchVendor; size?: number }) {
  const Icon = logos[vendor];
  return <Icon size={size} aria-hidden focusable="false" style={{ flexShrink: 0 }} />;
}
