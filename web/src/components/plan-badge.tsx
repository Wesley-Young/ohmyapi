import { Badge, type BadgeProps } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { Crown } from 'lucide-react';

import type { SubscriptionProvider } from '../lib/subscription';
import { Tooltip } from './icon-button';
import { subscriptionQuotaQuery } from './subscription-quota';

type Tier = 'free' | 'standard' | 'premium' | 'luxury' | 'flagship' | 'organization';

// 按月价对齐两家套餐：灰 → 蓝 → 紫 → 金 → 金色加强；按席位计费的组织套餐单独用青色。
// 金色自定义，避免与并发告警使用的 yellow 混淆。
const tierStyles: Record<Tier, BadgeProps> = {
  free: { colorPalette: 'gray' },
  standard: { colorPalette: 'blue' },
  premium: { colorPalette: 'purple' },
  luxury: { bg: '#FBF3DB', color: '#8A6A12' },
  flagship: { bgImage: 'linear-gradient(135deg, #FFF1B8, #FFD45C 55%, #F2B419)', color: '#4A3200', gap: '1' },
  organization: { colorPalette: 'teal' },
};

// OpenAI 套餐标识来自 Codex 协议（与 sub2api 的展示名称一致）。
const openAIPlans: Record<string, { label: string; tier: Tier }> = {
  free: { label: 'Free', tier: 'free' },
  go: { label: 'Go', tier: 'standard' },
  plus: { label: 'Plus', tier: 'standard' },
  prolite: { label: 'Pro 100', tier: 'premium' },
  pro: { label: 'Pro 200', tier: 'luxury' },
  chatgptpro: { label: 'Pro 200', tier: 'luxury' },
  promax: { label: 'Pro 500', tier: 'flagship' },
  team: { label: 'Business', tier: 'organization' },
  selfservebusinessusagebased: { label: 'Business', tier: 'organization' },
  selfservebusinessprolite: { label: 'Business Premium', tier: 'organization' },
  business: { label: 'Enterprise', tier: 'organization' },
  enterprise: { label: 'Enterprise', tier: 'organization' },
  ent26: { label: 'Enterprise', tier: 'organization' },
  enterprisecbpusagebased: { label: 'Enterprise', tier: 'organization' },
  enterprisecbpautomation: { label: 'Enterprise (Automation)', tier: 'organization' },
  edu: { label: 'Edu', tier: 'organization' },
  eduplus: { label: 'Edu Plus', tier: 'organization' },
  edupro: { label: 'Edu Pro', tier: 'organization' },
};

const claudePlans: Record<string, { label: string; tier: Tier }> = {
  claude_free: { label: 'Free', tier: 'free' },
  claude_pro: { label: 'Pro', tier: 'standard' },
  claude_max: { label: 'Max', tier: 'premium' },
  claude_team: { label: 'Team', tier: 'organization' },
  claude_enterprise: { label: 'Enterprise', tier: 'organization' },
};

/** 识别不出的套餐原样显示为灰色。 */
function planInfo(provider: SubscriptionProvider, raw: string): { label: string; tier: Tier } {
  if (provider === 'openai') return openAIPlans[raw.replace(/[\s_-]+/g, '')] ?? { label: raw, tier: 'free' };
  // Max 的倍数只出现在 rate_limit_tier（如 default_claude_max_5x），按数字归档以兼容新倍数。
  const multiple = raw.match(/max_(\d+)x/)?.[1];
  if (multiple) return { label: `Max ${multiple}x`, tier: Number(multiple) >= 20 ? 'luxury' : 'premium' };
  return claudePlans[raw] ?? { label: raw, tier: 'free' };
}

export function PlanBadge({
  provider,
  channelId,
  enabled,
}: {
  provider: SubscriptionProvider;
  channelId: string;
  enabled: boolean;
}) {
  const plan = useQuery(subscriptionQuotaQuery(provider, channelId, enabled)).data?.plan;
  return plan ? <PlanLabel provider={provider} plan={plan} /> : null;
}

function PlanLabel({ provider, plan }: { provider: SubscriptionProvider; plan: string }) {
  const { label, tier } = planInfo(provider, plan);
  return (
    <Tooltip content={`上游套餐标识：${plan}`}>
      <Badge {...tierStyles[tier]}>
        {tier === 'flagship' && <Crown size={12} strokeWidth={2} aria-hidden="true" focusable="false" />}
        {label}
      </Badge>
    </Tooltip>
  );
}
