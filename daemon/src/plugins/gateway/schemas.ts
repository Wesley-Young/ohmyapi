import { z } from 'zod';

import { pageInput } from '../../core/pagination.ts';

export const listRequestsInput = z
  .object({ page: pageInput, reviewOnly: z.boolean().default(false) })
  .default({ page: 0, reviewOnly: false });
