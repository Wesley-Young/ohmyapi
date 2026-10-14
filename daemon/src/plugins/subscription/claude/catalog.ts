import { z } from 'zod';

import { AppError } from '../../../core/errors.ts';
import type { OutboundFetch } from '../../outbound/index.ts';
import { readJson } from '../openai/client.ts';
import { claudeBaseUrl } from './client.ts';
import type { ClaudeCredentials } from './credentials.ts';
import { claudeCodeVersion } from './request.ts';

const catalogSchema = z.object({
  model_selector_config: z
    .array(z.object({ id: z.string(), models: z.array(z.unknown()).max(1000).optional() }))
    .max(100),
});
const modelSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/),
  disabled: z.boolean().optional(),
  section: z.string().optional(),
});

export async function fetchClaudeModels(credentials: ClaudeCredentials, request: OutboundFetch) {
  // 依据 CC 2.1.284 的 model_selector 协议；有组织信息时使用组织路由，令牌导入可使用无组织路由。
  const org = credentials.organizationId;
  const path = org ? `/api/organizations/${org}/model_selector/cc` : '/api/model_selector/cc';
  const headers = new Headers({
    accept: 'application/json, text/plain, */*',
    authorization: `Bearer ${credentials.accessToken}`,
    'user-agent': `claude-cli/${claudeCodeVersion} (external, cli)`,
    'anthropic-client-platform': 'claude_code_cli',
  });
  if (org) {
    headers.set('content-type', 'application/json');
    headers.set('anthropic-version', '2023-06-01');
    headers.set('x-organization-uuid', org);
  } else {
    headers.set('anthropic-beta', 'oauth-2025-04-20');
  }
  const response = await request(`${claudeBaseUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(
      'bad_request',
      response.status === 404
        ? 'Claude 模型目录接口不可用（HTTP 404），请手动添加模型'
        : `获取 Claude 模型失败（HTTP ${response.status}），请检查账号权限和出站代理，或手动添加模型`,
    );
  }
  const result = catalogSchema.safeParse(await readJson(response));
  if (!result.success) throw new AppError('bad_request', 'Claude 模型目录格式无效，请手动添加模型');
  const rows = result.data.model_selector_config.find((surface) => surface.id === 'cc')?.models;
  if (!rows) throw new AppError('bad_request', '该 Claude 账号未下发 CC 模型目录，请手动添加模型');
  const names = new Set<string>();
  let ignored = 0;
  let unavailable = 0;
  for (const row of rows) {
    const model = modelSchema.safeParse(row);
    if (!model.success) {
      ignored++;
      continue;
    }
    // 与 CC 的可选行过滤一致，保留 overflow 分组，排除 disabled 和 deprecated。
    if (model.data.disabled || model.data.section === 'deprecated') {
      unavailable++;
      continue;
    }
    names.add(model.data.id);
  }
  if (!names.size) throw new AppError('bad_request', 'Claude 未返回可选模型，请检查账号权限或手动添加模型');
  return { names: [...names].sort(), ignored, unavailable };
}
