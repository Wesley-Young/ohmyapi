import { adminProcedure, protectedProcedure } from '../../trpc/procedures.ts';
import type { KeyService } from '../keys/service.ts';
import { previewInput, priceScope, savePriceInput } from './schemas.ts';
import type { PricingService } from './service.ts';

export function pricingRoutes(pricing: PricingService, keys: KeyService) {
  return {
    modelPlaza: protectedProcedure.query(async ({ ctx }) => pricing.plaza(await keys.offerings(ctx.principal.user))),
    admin: {
      list: adminProcedure.input(priceScope).query(({ input }) => pricing.list(input)),
      save: adminProcedure.input(savePriceInput).mutation(({ ctx, input }) => pricing.save(ctx.principal, input)),
      preview: adminProcedure.input(previewInput).mutation(({ input }) => pricing.preview(input)),
    },
  };
}
