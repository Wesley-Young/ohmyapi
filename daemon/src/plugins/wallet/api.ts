import { createRoute, z } from '@hono/zod-openapi';

import {
  type ApiAuth,
  createApi,
  errorResponse,
  jsonBody,
  jsonResponse,
  moneySchema,
  userIdParams,
} from '../../openapi/common.ts';
import { adjustmentAmount, adjustmentReason } from './schemas.ts';
import type { WalletService } from './service.ts';

const walletSchema = z
  .object({
    currency: z.string().meta({ description: '显示用的货币单位', example: 'USD' }),
    balance: moneySchema.meta({ description: '余额' }),
    reserved: moneySchema.meta({ description: '进行中的请求预占的金额' }),
    available: moneySchema.meta({ description: '可用余额，即余额减去预占' }),
  })
  .meta({ id: 'Wallet' });

const adjustmentSchema = z
  .object({
    id: z.uuid(),
    amount: moneySchema.meta({ description: '调整金额，扣减为负数' }),
    balanceAfter: moneySchema.meta({ description: '调整后的余额' }),
    reason: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'WalletAdjustment' });

const adjustmentHeaders = z.object({
  'idempotency-key': z
    .string({ error: '缺少 Idempotency-Key 请求头' })
    .regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'Idempotency-Key 需为 1–128 位字母、数字或 _ . : -')
    .meta({
      description: '幂等键，如支付订单号。相同的键重复提交时返回首次的结果，参数不同时返回 409',
      example: 'order-20261015-0001',
    }),
});

const unauthorized = errorResponse('缺少管理令牌，或令牌无效、已过期');
const forbidden = errorResponse('令牌缺少所需权限');

export function walletApi(wallet: WalletService, auth: ApiAuth) {
  const read = auth.admin('wallet:read');
  const write = auth.admin('wallet:write');
  return createApi()
    .openapi(
      createRoute({
        method: 'get',
        path: '/me/balance',
        tags: ['Me'],
        summary: '当前用户的余额',
        security: auth.apiKey.security,
        middleware: [auth.apiKey.middleware] as const,
        responses: {
          200: jsonResponse(walletSchema, '余额'),
          401: errorResponse('缺少 API Key，或 Key 无效、已过期'),
        },
      }),
      async (c) => c.json(await wallet.get(c.get('identity').user.id), 200),
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/admin/users/{userId}/wallet',
        tags: ['Wallet'],
        summary: '用户余额',
        description: '需要权限 `wallet:read`。',
        security: read.security,
        middleware: [read.middleware] as const,
        request: { params: userIdParams },
        responses: {
          200: jsonResponse(walletSchema, '余额'),
          401: unauthorized,
          403: forbidden,
          404: errorResponse('用户不存在'),
        },
      }),
      async (c) => c.json(await wallet.get(c.req.valid('param').userId), 200),
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/admin/users/{userId}/wallet/adjustments',
        tags: ['Wallet'],
        summary: '调整余额',
        description:
          '正数充值，负数扣减，扣减额以可用余额为上限。必须携带 `Idempotency-Key`。需要权限 `wallet:write`。',
        security: write.security,
        middleware: [write.middleware] as const,
        request: {
          params: userIdParams,
          headers: adjustmentHeaders,
          body: jsonBody(
            z
              .object({
                amount: adjustmentAmount.meta({ description: '金额，正数充值、负数扣减，最多六位小数', example: '10' }),
                reason: adjustmentReason.meta({ description: '原因，最多 300 个字符', example: '在线充值' }),
              })
              .meta({ id: 'AdjustWallet' }),
          ),
        },
        responses: {
          200: jsonResponse(adjustmentSchema, '余额调整记录；幂等重放时返回首次的记录'),
          400: errorResponse('参数无效，或扣减金额超过可用余额'),
          401: unauthorized,
          403: forbidden,
          404: errorResponse('用户不存在或已删除'),
          409: errorResponse('幂等键已用于参数不同的调整'),
        },
      }),
      async (c) => {
        const entry = await wallet.adjust(c.get('principal'), {
          userId: c.req.valid('param').userId,
          idempotencyKey: c.req.valid('header')['idempotency-key'],
          ...c.req.valid('json'),
        });
        return c.json(
          {
            id: entry.id,
            amount: entry.amount,
            balanceAfter: entry.balanceAfter,
            reason: entry.reason,
            createdAt: entry.createdAt,
          },
          200,
        );
      },
    );
}
