import { z } from 'zod';

import { pageInput } from '../../core/pagination.ts';

const requestFilters = z
  .object({
    page: pageInput,
    model: z.string().trim().max(256).optional(),
    from: z.iso.datetime().optional(),
    until: z.iso.datetime().optional(),
  })
  .refine(({ from, until }) => !from || !until || Date.parse(from) < Date.parse(until), {
    message: '结束时间须晚于开始时间',
    path: ['until'],
  });

export const ownRequestsInput = requestFilters.safeExtend({ apiKeyId: z.uuid().optional() }).default({ page: 0 });
export const listRequestsInput = requestFilters
  .safeExtend({
    userId: z.uuid().optional(),
    channelId: z.uuid().optional(),
    reviewOnly: z.boolean().default(false),
  })
  .default({ page: 0, reviewOnly: false });

export type OwnRequestFilters = z.infer<typeof ownRequestsInput>;
export type PlatformRequestFilters = z.infer<typeof listRequestsInput>;
