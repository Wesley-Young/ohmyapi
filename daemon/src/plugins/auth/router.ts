import { adminProcedure, publicProcedure, signedInProcedure } from '../../trpc/procedures.ts';
import { adminTokenIdInput, changePasswordInput, createAdminTokenInput, loginInput } from './schemas.ts';
import type { AuthService } from './service.ts';
import type { AdminTokens } from './tokens.ts';

export function authRoutes(auth: AuthService) {
  return {
    me: publicProcedure.query(({ ctx }) => ctx.principal?.user ?? null),
    login: publicProcedure.input(loginInput).mutation(async ({ ctx, input }) => {
      const result = await auth.login(input.username, input.password);
      ctx.setSession(result.token, result.expiresAt);
      return result.user;
    }),
    logout: publicProcedure.mutation(async ({ ctx }) => {
      await auth.logout(ctx.token);
      ctx.clearSession();
      return { success: true };
    }),
    changePassword: signedInProcedure.input(changePasswordInput).mutation(async ({ ctx, input }) => {
      const session = await auth.changePassword(ctx.principal, input.currentPassword, input.newPassword);
      ctx.setSession(session.token, session.expiresAt);
      return { success: true };
    }),
  };
}

/** 当前管理员自己的管理令牌。 */
export function adminTokenRoutes(tokens: AdminTokens) {
  return {
    list: adminProcedure.query(({ ctx }) => tokens.list(ctx.principal)),
    create: adminProcedure
      .input(createAdminTokenInput)
      .mutation(({ ctx, input }) => tokens.create(ctx.principal, input)),
    revoke: adminProcedure
      .input(adminTokenIdInput)
      .mutation(({ ctx, input }) => tokens.revoke(ctx.principal, input.tokenId)),
  };
}
