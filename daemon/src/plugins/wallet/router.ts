import { paginationInput } from '../../core/pagination.js';
import { adminProcedure, protectedProcedure } from '../../trpc/procedures.js';
import { userIdInput } from '../users/schemas.js';
import { adjustWalletInput, statsRangeInput, userLedgerInput } from './schemas.js';
import type { WalletService } from './service.js';

export function walletRoutes(wallet: WalletService) {
  return {
    /** 当前用户自己的钱包。 */
    user: {
      get: protectedProcedure.query(({ ctx }) => wallet.get(ctx.principal.user.id)),
      stats: protectedProcedure.query(({ ctx }) => wallet.stats(ctx.principal.user.id)),
      trend: protectedProcedure.query(({ ctx }) => wallet.trend(ctx.principal.user.id)),
      models: protectedProcedure
        .input(statsRangeInput)
        .query(({ ctx, input }) => wallet.models(ctx.principal.user.id, input.range)),
      ledger: protectedProcedure
        .input(paginationInput)
        .query(({ ctx, input }) => wallet.ledger(ctx.principal.user.id, input.page)),
    },
    /** 全站统计。 */
    platform: {
      stats: adminProcedure.query(() => wallet.platformStats()),
      reviewCount: adminProcedure.query(() => wallet.reviewCount()),
      models: adminProcedure.input(statsRangeInput).query(({ input }) => wallet.models(undefined, input.range)),
    },
    /** 管理员查看和调整任意用户的钱包。 */
    admin: {
      get: adminProcedure.input(userIdInput).query(({ input }) => wallet.get(input.userId)),
      ledger: adminProcedure.input(userLedgerInput).query(({ input }) => wallet.ledger(input.userId, input.page)),
      adjust: adminProcedure.input(adjustWalletInput).mutation(({ ctx, input }) => wallet.adjust(ctx.principal, input)),
    },
  };
}
