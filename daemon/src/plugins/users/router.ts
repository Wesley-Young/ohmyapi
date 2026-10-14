import { adminProcedure } from '../../trpc/procedures.ts';
import {
  createUserInput,
  listUsersInput,
  resetPasswordInput,
  setRoleInput,
  setStatusInput,
  userIdInput,
} from './schemas.ts';
import type { UserService } from './service.ts';

export function userAdminRoutes(users: UserService) {
  return {
    list: adminProcedure.input(listUsersInput).query(({ input }) => users.list(input.page, input.search)),
    get: adminProcedure.input(userIdInput).query(({ input }) => users.get(input.userId)),
    createDefaults: adminProcedure.query(() => users.createDefaults()),
    delete: adminProcedure
      .input(userIdInput)
      .mutation(({ ctx, input }) => users.manage(ctx.principal, input.userId, 'delete')),
    create: adminProcedure.input(createUserInput).mutation(({ ctx, input }) => users.create(ctx.principal, input)),
    setRole: adminProcedure
      .input(setRoleInput)
      .mutation(({ ctx, input }) => users.setRole(ctx.principal, input.userId, input.role)),
    setStatus: adminProcedure
      .input(setStatusInput)
      .mutation(({ ctx, input }) =>
        users.manage(ctx.principal, input.userId, input.status === 'active' ? 'enable' : 'disable'),
      ),
    resetPassword: adminProcedure
      .input(resetPasswordInput)
      .mutation(({ ctx, input }) => users.manage(ctx.principal, input.userId, 'reset_password', input.password)),
    revokeSessions: adminProcedure
      .input(userIdInput)
      .mutation(({ ctx, input }) => users.manage(ctx.principal, input.userId, 'revoke_sessions')),
  };
}
