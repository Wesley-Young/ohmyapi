import { z } from 'zod';

import { pageInput, searchInput } from '../../core/pagination.ts';
import { channelTypes, endpoints, pricingModes } from '../database/schema/index.ts';
import { proxyUrlInput } from '../outbound/schemas.ts';
import { multiplierInput, ruleInput } from '../pricing/schemas.ts';
import { subscriptionInput } from '../subscription/schemas.ts';
import { userIdInput } from '../users/schemas.ts';

const name = z.string().trim().min(1).max(128);
export const modelName = name.regex(/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/, '模型名称格式无效');
export const channelInput = z.object({
  id: z.uuid().optional(),
  name,
  type: z.enum(channelTypes).default('api'),
  pricingMode: z.enum(pricingModes).optional(),
  baseUrl: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }, 'Base URL 需为无凭据、查询参数和片段的 HTTP(S) 地址')
    .optional(),
  proxyUrl: proxyUrlInput,
  subscription: subscriptionInput.optional(),
  credential: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/, '凭据不能包含空格或控制字符')
    .optional(),
  enabled: z.boolean(),
  isPublic: z.boolean().default(true),
  timeoutMs: z.number().int().min(100).max(600_000),
  multiplier: multiplierInput.optional(),
  availableModels: z
    .array(z.object({ name: modelName, multiplier: multiplierInput.nullable() }))
    .max(1000, '每个渠道最多添加 1000 个模型')
    .refine((items) => new Set(items.map((item) => item.name)).size === items.length, '模型不能重复')
    .optional(),
  members: z
    .array(
      z.object({
        channelId: z.uuid(),
        priority: z.number().int().min(0).max(1000).default(0),
        weight: z.number().int().min(1).max(1000).default(1),
      }),
    )
    .max(100)
    .refine((items) => new Set(items.map((item) => item.channelId)).size === items.length, '子渠道不能重复')
    .default([]),
  endpoints: z
    .array(z.enum(endpoints))
    .max(4)
    .refine((v) => new Set(v).size === v.length)
    .default([]),
});
export const fetchChannelModelsInput = channelInput
  .pick({ id: true, baseUrl: true, credential: true, proxyUrl: true })
  .required({ baseUrl: true });
export const modelInput = z.object({
  id: z.uuid().optional(),
  name: modelName,
  enabled: z.boolean(),
  inputTokenLimit: z.number().int().min(1).default(1_000_000),
  outputTokenLimit: z.number().int().min(1).default(128_000),
});
export const importModelsInput = z.object({
  models: z
    .array(
      z.object({
        model: modelInput.omit({ id: true }),
        providerId: z.string().min(1).max(128),
        preset: z.enum(['none', 'gpt', 'deepseek']),
        rules: z.array(ruleInput).min(1).max(3),
      }),
    )
    .min(1, '至少选择一个模型')
    .max(100, '每次最多导入 100 个模型')
    .refine((rows) => new Set(rows.map((row) => row.model.name)).size === rows.length, '不能导入同名模型的多个来源'),
});

export const channelIdInput = z.object({ channelId: z.uuid() });
export const modelIdInput = z.object({ modelId: z.uuid() });
export const channelGrantsInput = z.object({ channelId: z.uuid(), page: pageInput, search: searchInput });
export const setChannelGrantsInput = z.object({
  channelId: z.uuid(),
  grants: z
    .array(z.object({ userId: z.uuid(), granted: z.boolean() }))
    .min(1, '请选择要修改授权的用户')
    .max(1000, '每次最多修改 1000 个用户的授权')
    .refine((grants) => new Set(grants.map((grant) => grant.userId)).size === grants.length, '用户不能重复'),
});
export const setGrantsInput = userIdInput.extend({ channelIds: z.array(z.uuid()).max(100) });

export type ChannelInput = z.infer<typeof channelInput>;
export type FetchChannelModelsInput = z.infer<typeof fetchChannelModelsInput>;
export type ModelInput = z.infer<typeof modelInput>;
export type ImportModelsInput = z.infer<typeof importModelsInput>;
