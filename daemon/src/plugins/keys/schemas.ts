import { z } from 'zod';

const keyName = z.string().trim().min(1, '请填写名称').max(64, '名称最多 64 个字符');
const keyModelIds = z.array(z.uuid()).min(1, '至少选择一个模型').max(100);

export const keyIdInput = z.object({ keyId: z.uuid() });
export const bindChannelInput = z.object({ keyId: z.uuid(), channelId: z.uuid() });
export const createKeyInput = z.object({
  name: keyName,
  channelId: z.uuid(),
  expiresAt: z.iso.datetime().optional(),
  modelIds: keyModelIds.optional(),
});
export const updateKeyInput = z.object({
  keyId: z.uuid(),
  name: keyName,
  channelId: z.uuid().optional(),
  expiresAt: z.iso.datetime().nullable(),
  modelIds: keyModelIds.nullable().optional(),
});

export type CreateKeyInput = z.infer<typeof createKeyInput>;
export type UpdateKeyInput = z.infer<typeof updateKeyInput>;
