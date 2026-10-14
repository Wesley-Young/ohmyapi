import { publicProcedure, signedInProcedure } from '../../trpc/procedures.js';
import { changePasswordInput, loginInput } from './schemas.js';
import type { AuthService } from './service.js';

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
