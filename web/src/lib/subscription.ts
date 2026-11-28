import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

/** 订阅平台，与后端定义保持一致。 */
export type SubscriptionProvider = NonNullable<
  RouterOutputs['admin']['catalog']['list']['channels'][number]['subscription']
>['provider'];

export const subscriptionProviderLabels = {
  openai: 'OpenAI',
  claude: 'Claude',
  zhipu: '智谱',
  antigravity: 'Antigravity',
} satisfies Record<SubscriptionProvider, string>;

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
} satisfies Record<Exclude<SubscriptionProvider, 'zhipu'>, { callback: string; credentials: string }>;

export const isSubscriptionProvider = (value: string): value is SubscriptionProvider =>
  Object.hasOwn(subscriptionProviderLabels, value);
