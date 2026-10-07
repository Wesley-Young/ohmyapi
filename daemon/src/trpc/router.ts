import { type inferRouterInputs, type inferRouterOutputs, initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';

import { parseMoney } from '../billing/conventions.js';
import type { AuthService, Principal } from '../services/auth.js';
import { type BillingService, correctBillInput, resolveBillInput } from '../services/billing.js';
import {
  type CatalogService,
  channelInput,
  fetchChannelModelsInput,
  importModelsInput,
  modelInput,
} from '../services/catalog.js';
import type { GatewayService } from '../services/gateway.js';
import type { KeyService } from '../services/keys.js';
import { type PricingService, previewInput, priceScope, savePriceInput } from '../services/pricing.js';
import type { UserService } from '../services/users.js';
import type { WalletService } from '../services/wallet.js';

export interface RpcContext {
  startedAt: string;
  principal: Principal | null;
  token?: string;
  auth: AuthService;
  keys: KeyService;
  users: UserService;
  wallet: WalletService;
  catalog: CatalogService;
  gateway: GatewayService;
  pricing: PricingService;
  billing: BillingService;
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

const signedIn = t.procedure.use(({ ctx, next }) => {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED', message: '请先登录' });
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});
const protectedProcedure = signedIn;
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.principal.user.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN', message: '需要管理员权限' });
  return next();
});

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.-]{2,63}$/, '用户名需为 3–64 位小写字母、数字、点、下划线或连字符');
const password = z
  .string()
  .min(8, '密码至少 8 个字符')
  .max(1024, '密码过长')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 1024, '密码过长');
const currentPassword = z.string().min(1, '请填写密码').max(1024, '密码过长');
const userId = z.object({ userId: z.uuid('用户标识无效') });
const page = z.number().int().min(0).max(100_000).default(0);
const pagination = z.object({ page }).default({ page: 0 });

export const appRouter = t.router({
  system: t.router({
    status: t.procedure.query(({ ctx }) => ({ name: 'ohmyapi', status: 'ok' as const, startedAt: ctx.startedAt })),
  }),
  auth: t.router({
    me: t.procedure.query(({ ctx }) => ctx.principal?.user ?? null),
    login: t.procedure.input(z.object({ username, password: currentPassword })).mutation(async ({ ctx, input }) => {
      const result = await ctx.auth.login(input.username, input.password);
      ctx.setSession(result.token, result.expiresAt);
      return result.user;
    }),
    logout: t.procedure.mutation(async ({ ctx }) => {
      await ctx.auth.logout(ctx.token);
      ctx.clearSession();
      return { success: true };
    }),
    changePassword: signedIn
      .input(z.object({ currentPassword, newPassword: password }))
      .mutation(async ({ ctx, input }) => {
        const session = await ctx.auth.changePassword(ctx.principal, input.currentPassword, input.newPassword);
        ctx.setSession(session.token, session.expiresAt);
        return { success: true };
      }),
  }),
  keys: t.router({
    list: protectedProcedure
      .input(pagination)
      .query(({ ctx, input }) => ctx.keys.list(ctx.principal.user.id, input.page)),
    channels: protectedProcedure.query(({ ctx }) => ctx.keys.availableChannels(ctx.principal)),
    bindChannel: protectedProcedure
      .input(z.object({ keyId: z.uuid(), channelId: z.uuid() }))
      .mutation(({ ctx, input }) => ctx.keys.bindChannel(ctx.principal, input.keyId, input.channelId)),
    models: protectedProcedure.query(({ ctx }) => ctx.keys.availableModels(ctx.principal)),
    create: protectedProcedure
      .input(
        z.object({
          name: z.string().trim().min(1, '请填写名称').max(64, '名称最多 64 个字符'),
          channelId: z.uuid(),
          expiresAt: z.iso.datetime().optional(),
          modelIds: z.array(z.uuid()).min(1, '至少选择一个模型').max(100).optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.keys.create(ctx.principal, input)),
    delete: protectedProcedure
      .input(z.object({ keyId: z.uuid() }))
      .mutation(({ ctx, input }) => ctx.keys.delete(ctx.principal, input.keyId)),
  }),
  wallet: t.router({
    get: protectedProcedure.query(({ ctx }) => ctx.wallet.get(ctx.principal.user.id)),
    stats: protectedProcedure.query(({ ctx }) => ctx.wallet.stats(ctx.principal.user.id)),
    trend: protectedProcedure.query(({ ctx }) => ctx.wallet.trend(ctx.principal.user.id)),
    ledger: protectedProcedure
      .input(pagination)
      .query(({ ctx, input }) => ctx.wallet.ledger(ctx.principal.user.id, input.page)),
  }),
  requests: protectedProcedure
    .input(pagination)
    .query(({ ctx, input }) => ctx.gateway.list(ctx.principal.user.id, input.page)),
  requestDetail: protectedProcedure
    .input(z.object({ requestId: z.uuid() }))
    .query(({ ctx, input }) => ctx.billing.detail(ctx.principal, input.requestId)),
  admin: t.router({
    stats: adminProcedure.query(({ ctx }) => ctx.wallet.platformStats()),
    billing: t.router({
      resolve: adminProcedure
        .input(resolveBillInput)
        .mutation(({ ctx, input }) => ctx.billing.resolve(ctx.principal, input)),
      correct: adminProcedure
        .input(correctBillInput)
        .mutation(({ ctx, input }) => ctx.billing.correct(ctx.principal, input)),
      reconcile: adminProcedure.input(userId).query(({ ctx, input }) => ctx.billing.reconcile(input.userId)),
    }),
    pricing: t.router({
      list: adminProcedure.input(priceScope).query(({ ctx, input }) => ctx.pricing.list(input)),
      save: adminProcedure.input(savePriceInput).mutation(({ ctx, input }) => ctx.pricing.save(ctx.principal, input)),
      preview: adminProcedure.input(previewInput).mutation(({ ctx, input }) => ctx.pricing.preview(input)),
    }),
    catalog: t.router({
      list: adminProcedure.query(({ ctx }) => ctx.catalog.list()),
      fetchChannelModels: adminProcedure
        .input(fetchChannelModelsInput)
        .mutation(({ ctx, input }) => ctx.catalog.fetchChannelModels(ctx.principal, input)),
      saveChannel: adminProcedure
        .input(channelInput)
        .mutation(({ ctx, input }) => ctx.catalog.saveChannel(ctx.principal, input)),
      deleteChannel: adminProcedure
        .input(z.object({ channelId: z.uuid() }))
        .mutation(({ ctx, input }) => ctx.catalog.deleteChannel(ctx.principal, input.channelId)),
      saveModel: adminProcedure
        .input(modelInput)
        .mutation(({ ctx, input }) => ctx.catalog.saveModel(ctx.principal, input)),
      deleteModel: adminProcedure
        .input(z.object({ modelId: z.uuid() }))
        .mutation(({ ctx, input }) => ctx.catalog.deleteModel(ctx.principal, input.modelId)),
      importModels: adminProcedure
        .input(importModelsInput)
        .mutation(({ ctx, input }) => ctx.catalog.importModels(ctx.principal, input)),
      grants: adminProcedure.input(userId).query(({ ctx, input }) => ctx.catalog.grants(input.userId)),
      setGrants: adminProcedure
        .input(userId.extend({ modelIds: z.array(z.uuid()).max(100) }))
        .mutation(({ ctx, input }) => ctx.catalog.setGrants(ctx.principal, input.userId, input.modelIds)),
    }),
    requests: adminProcedure
      .input(z.object({ page, reviewOnly: z.boolean().default(false) }).default({ page: 0, reviewOnly: false }))
      .query(({ ctx, input }) => ctx.gateway.list(undefined, input.page, input.reviewOnly)),
    users: t.router({
      list: adminProcedure
        .input(z.object({ page, search: z.string().trim().max(64).default('') }).default({ page: 0, search: '' }))
        .query(({ ctx, input }) => ctx.users.list(input.page, input.search)),
      get: adminProcedure.input(userId).query(({ ctx, input }) => ctx.users.get(input.userId)),
      delete: adminProcedure
        .input(userId)
        .mutation(({ ctx, input }) => ctx.users.manage(ctx.principal, input.userId, 'delete')),
      create: adminProcedure
        .input(z.object({ username, password: password.optional() }))
        .mutation(({ ctx, input }) => ctx.users.create(ctx.principal, input.username, input.password)),
      setStatus: adminProcedure
        .input(userId.extend({ status: z.enum(['active', 'disabled']) }))
        .mutation(({ ctx, input }) =>
          ctx.users.manage(ctx.principal, input.userId, input.status === 'active' ? 'enable' : 'disable'),
        ),
      resetPassword: adminProcedure
        .input(userId.extend({ password }))
        .mutation(({ ctx, input }) => ctx.users.manage(ctx.principal, input.userId, 'reset_password', input.password)),
      revokeSessions: adminProcedure
        .input(userId)
        .mutation(({ ctx, input }) => ctx.users.manage(ctx.principal, input.userId, 'revoke_sessions')),
    }),
    wallet: t.router({
      get: adminProcedure.input(userId).query(({ ctx, input }) => ctx.wallet.get(input.userId)),
      ledger: adminProcedure
        .input(userId.extend({ page }))
        .query(({ ctx, input }) => ctx.wallet.ledger(input.userId, input.page)),
      adjust: adminProcedure
        .input(
          userId.extend({
            amount: z.string().refine((value) => {
              try {
                return parseMoney(value) !== 0n;
              } catch {
                return false;
              }
            }, '请输入非零金额，最多六位小数'),
            reason: z.string().trim().max(300, '原因最多 300 个字符').default(''),
            idempotencyKey: z.uuid(),
          }),
        )
        .mutation(({ ctx, input }) => ctx.wallet.adjust(ctx.principal, input)),
    }),
  }),
});

export type AppRouter = typeof appRouter;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export type RouterInputs = inferRouterInputs<AppRouter>;
