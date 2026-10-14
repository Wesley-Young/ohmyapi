import { z } from 'zod';

import { subscriptionProviders } from '../database/schema/index.ts';
import { proxyUrlInput } from '../outbound/schemas.ts';

export const credentialInput = z.object({
  provider: z.enum(subscriptionProviders).default('openai'),
  credentials: z.string().min(1).max(60000).optional(),
  callbackUrl: z.url().max(8192).optional(),
});
export const subscriptionInput = credentialInput
  .extend({ maxConcurrent: z.number().int().min(1).max(100).default(5) })
  .refine((input) => !(input.credentials && input.callbackUrl), '请选择一种接入方式');
export const fetchSubscriptionModelsInput = credentialInput
  .extend({ channelId: z.uuid().optional(), proxyUrl: proxyUrlInput })
  .refine((input) => !(input.credentials && input.callbackUrl), '请选择一种接入方式');

const channelId = z.uuid();
export const subscriptionChannelInput = z.object({ channelId });
export const consumeResetCreditInput = z.object({
  channelId,
  creditId: z.string().min(1).max(256),
  redeemRequestId: z.uuid(),
});
export const setCycleResetInput = z.object({ channelId, resetAt: z.iso.datetime({ offset: true }).nullable() });
export const startOAuthInput = z.object({ provider: z.enum(subscriptionProviders).default('openai') }).optional();

export type CredentialInput = z.infer<typeof credentialInput>;
export type FetchSubscriptionModelsInput = z.infer<typeof fetchSubscriptionModelsInput>;
export type ConsumeResetCreditInput = z.infer<typeof consumeResetCreditInput>;
export type SetCycleResetInput = z.infer<typeof setCycleResetInput>;
