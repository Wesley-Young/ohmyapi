import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

import { type Endpoint, responsesEndpoints } from './endpoints';

/** 订阅平台，与后端定义保持一致。 */
export type SubscriptionProvider = NonNullable<
  RouterOutputs['admin']['catalog']['list']['channels'][number]['subscription']
>['provider'];

export const subscriptionProviderLabels = {
  openai: 'OpenAI',
  claude: 'Claude',
  antigravity: 'Antigravity',
} satisfies Record<SubscriptionProvider, string>;

/** 各订阅平台可转发的端点，与后端的 providerEndpoints 一致。 */
export const subscriptionEndpoints: Record<SubscriptionProvider, readonly Endpoint[]> = {
  openai: responsesEndpoints,
  claude: ['/v1/messages'],
  antigravity: ['/v1beta/generateContent'],
};

/** 订阅授权的回调地址与凭据导入说明。 */
export const subscriptionAccessHints = {
  openai: { callback: 'localhost:1455/auth/callback', credentials: '粘贴 ~/.codex/auth.json 文件内容' },
  claude: {
    callback: 'localhost:54545/callback',
    credentials: '粘贴 CPA Claude 凭据或 claudeAiOauth JSON；缺少账号 ID 时通过出站代理查询',
  },
  antigravity: {
    callback: 'localhost:51121/oauth-callback',
    credentials: '粘贴 CPA Antigravity 凭据 JSON（需要 refresh_token）；账号和项目通过出站代理查询',
  },
} satisfies Record<SubscriptionProvider, { callback: string; credentials: string }>;

export const isSubscriptionProvider = (value: string): value is SubscriptionProvider =>
  Object.hasOwn(subscriptionProviderLabels, value);
