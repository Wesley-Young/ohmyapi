import { initTRPC, type TRPC_ERROR_CODE_KEY, TRPCError } from '@trpc/server';
import { z } from 'zod';

import { AppError, type AppErrorKind } from '../core/errors.ts';
import { type EventLogger, formatEvent } from '../core/logging.ts';
import type { SessionPrincipal } from '../plugins/auth/service.ts';

/** 单次 RPC 请求的上下文；服务实例在创建路由时注入，不经过请求上下文传递。 */
export interface RpcContext {
  requestId: string;
  logger: EventLogger;
  principal: SessionPrincipal | null;
  token?: string;
  setSession(token: string, expiresAt: Date): void;
  clearSession(): void;
}

const t = initTRPC.context<RpcContext>().create({
  errorFormatter({ shape, error }) {
    const validation = error.cause instanceof z.ZodError ? error.cause : undefined;
    return {
      ...shape,
      message:
        error.code === 'INTERNAL_SERVER_ERROR'
          ? '操作失败，请稍后重试'
          : (validation?.issues[0]?.message ?? shape.message),
      data: {
        ...shape.data,
        stack: undefined,
        fieldErrors: validation ? (z.flattenError(validation).fieldErrors as Record<string, string[]>) : undefined,
      },
    };
  },
});

const errorCodes = {
  bad_request: 'BAD_REQUEST',
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  not_found: 'NOT_FOUND',
  conflict: 'CONFLICT',
  precondition_failed: 'PRECONDITION_FAILED',
  too_many_requests: 'TOO_MANY_REQUESTS',
  bad_gateway: 'BAD_GATEWAY',
} as const satisfies Record<AppErrorKind, TRPC_ERROR_CODE_KEY>;

export const router = t.router;

/** 所有过程的基础：把业务层的 AppError 转换为对应的 tRPC 错误，其余异常仍按内部错误处理。 */
export const publicProcedure = t.procedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof AppError) {
    const { cause } = result.error;
    throw new TRPCError({ code: errorCodes[cause.kind], message: cause.message, cause });
  }
  return result;
});

export const signedInProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED', message: '请先登录' });
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});

/** 已登录用户的过程；变更成功后记录操作日志。 */
export const protectedProcedure = signedInProcedure.use(async ({ ctx, path, type, next }) => {
  const result = await next();
  if (result.ok && type === 'mutation')
    ctx.logger.info(
      formatEvent('操作完成', { requestId: ctx.requestId, actorId: ctx.principal.user.id, operation: path }),
    );
  return result;
});

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.principal.user.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN', message: '需要管理员权限' });
  return next();
});
