import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

/** 订阅平台，与后端定义保持一致。 */
export type SubscriptionProvider = NonNullable<
  RouterOutputs['admin']['catalog']['list']['channels'][number]['subscription']
>['provider'];
