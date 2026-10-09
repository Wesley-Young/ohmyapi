import {
  Badge,
  Box,
  Button,
  Checkbox,
  Field,
  HStack,
  Link,
  NativeSelect,
  Stack,
  Table,
  Text,
  Textarea,
} from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { type ChannelModel, ChannelModels } from '../components/channel-models';
import { IconButton } from '../components/icon-button';
import { ConfirmAction, ErrorText, FormDialog, FormInput, Loading, PrimaryButton, Title } from '../components/ui';
import { formError } from '../lib/format';
import { queryClient, trpc, trpcClient } from '../lib/trpc';

export const endpoints = ['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/responses/compact'] as const;
export type Endpoint = (typeof endpoints)[number];
const responsesEndpoints: Endpoint[] = ['/v1/responses', '/v1/responses/compact'];
type CatalogData = RouterOutputs['admin']['catalog']['list'];
const channelTypeLabels = {
  api: 'API 渠道',
  subscription: '订阅渠道',
  aggregate: '聚合渠道',
} satisfies Record<CatalogData['channels'][number]['type'], string>;

export const refreshCatalog = () =>
  Promise.all([
    queryClient.invalidateQueries(trpc.admin.catalog.list.queryFilter()),
    queryClient.invalidateQueries(trpc.keys.models.queryFilter()),
    queryClient.invalidateQueries(trpc.keys.channels.queryFilter()),
    queryClient.invalidateQueries(trpc.keys.list.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.catalog.grants.pathFilter()),
  ]);

export function EndpointFields({
  value,
  onChange,
  subscription = false,
}: {
  value: Endpoint[];
  onChange: (value: Endpoint[]) => void;
  subscription?: boolean;
}) {
  return (
    <Box as="fieldset">
      <Text as="legend" fontSize="sm" fontWeight="500" mb="2">
        支持的端点
      </Text>
      <Stack gap="3">
        {endpoints
          .filter((endpoint) => endpoint !== '/v1/responses/compact' && (!subscription || endpoint === '/v1/responses'))
          .map((endpoint) => (
            <Checkbox.Root
              key={endpoint}
              checked={
                endpoint === '/v1/responses'
                  ? responsesEndpoints.some((item) => value.includes(item))
                  : value.includes(endpoint)
              }
              onCheckedChange={(e) => {
                const group = endpoint === '/v1/responses' ? responsesEndpoints : [endpoint];
                onChange(
                  e.checked === true
                    ? [...new Set([...value, ...group])]
                    : value.filter((item) => !group.includes(item)),
                );
              }}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label fontSize="sm">{endpoint}</Checkbox.Label>
            </Checkbox.Root>
          ))}
      </Stack>
    </Box>
  );
}

function Enabled({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <Checkbox.Root checked={value} onCheckedChange={(e) => onChange(e.checked === true)}>
      <Checkbox.HiddenInput />
      <Checkbox.Control />
      <Checkbox.Label>启用</Checkbox.Label>
    </Checkbox.Root>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { id: string; name: string }[];
  disabled?: boolean;
}) {
  return (
    <Field.Root>
      <Field.Label>{label}</Field.Label>
      <NativeSelect.Root disabled={disabled}>
        <NativeSelect.Field aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">请选择</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
    </Field.Root>
  );
}

function ChannelForm({
  initial,
  data,
  close,
  onSaved,
}: {
  initial?: CatalogData['channels'][number];
  data: CatalogData;
  close: () => void;
  onSaved: (result: RouterOutputs['admin']['catalog']['saveChannel']) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState(initial?.type ?? 'api');
  const [maximum, setMaximum] = useState(String(initial?.subscription?.maxConcurrent ?? 5));
  const [mode, setMode] = useState('import');
  const [credentials, setCredentials] = useState('');
  const [callback, setCallback] = useState('');
  const startOAuth = useMutation(trpc.admin.catalog.startSubscriptionOAuth.mutationOptions());
  const renew = useMutation(
    trpc.admin.catalog.refreshSubscription.mutationOptions({
      onSuccess: refreshCatalog,
      onError: refreshCatalog,
    }),
  );
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [credential, setCredential] = useState('');
  const [timeout, setTimeout] = useState(String(initial?.timeoutMs ?? 120000));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [isPublic, setIsPublic] = useState(initial?.isPublic ?? true);
  const [scopes, setScopes] = useState<Endpoint[]>(
    initial?.endpoints.some((endpoint) => responsesEndpoints.includes(endpoint))
      ? [...new Set([...initial.endpoints, ...responsesEndpoints])]
      : (initial?.endpoints ?? []),
  );
  const [multiplier, setMultiplier] = useState(initial?.multiplier ?? '1');
  const [available, setAvailable] = useState<ChannelModel[]>(
    initial?.availableModels.flatMap((entry) => {
      const model = data.models.find((model) => model.id === entry.modelId);
      return model ? [{ name: model.name, multiplier: entry.multiplier }] : [];
    }) ?? [],
  );
  const [fetchNotice, setFetchNotice] = useState<string>();
  const [fetchError, setFetchError] = useState<string>();
  const fetchOptions = {
    onMutate: () => {
      setFetchNotice(undefined);
      setFetchError(undefined);
    },
    onSuccess: (result: { names: string[]; ignored: number }) => {
      const additions = result.names.filter((name) => !available.some((model) => model.name === name));
      if (available.length + additions.length > 1000) {
        setFetchError('合并后超过 1000 个模型，请先移除部分模型');
        return;
      }
      setAvailable([...available, ...additions.map((name) => ({ name, multiplier: null }))]);
      setFetchNotice(
        `已拉取 ${result.names.length} 个模型，新增 ${additions.length} 个${result.ignored ? `，忽略 ${result.ignored} 个无效名称` : ''}`,
      );
    },
  };
  const fetchModels = useMutation(trpc.admin.catalog.fetchChannelModels.mutationOptions(fetchOptions));
  const fetchSubscriptionModels = useMutation(trpc.admin.catalog.fetchSubscriptionModels.mutationOptions(fetchOptions));
  const task = useMutation(
    trpc.admin.catalog.saveChannel.mutationOptions({
      onSuccess: async (result) => {
        setCredential('');
        setCredentials('');
        setCallback('');
        await refreshCatalog();
        onSaved(result);
        close();
      },
    }),
  );
  const fetching = fetchModels.isPending || fetchSubscriptionModels.isPending;
  const busy = task.isPending || fetching || startOAuth.isPending || renew.isPending;
  return (
    <FormDialog open title={initial ? '编辑渠道' : '添加渠道'} onClose={close} busy={busy} size="xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy)
            task.mutate({
              id: initial?.id,
              name,
              type,
              baseUrl: type === 'api' ? baseUrl : undefined,
              credential: type === 'api' ? credential || undefined : undefined,
              subscription:
                type === 'subscription'
                  ? {
                      maxConcurrent: Number(maximum),
                      credentials: mode === 'import' ? credentials || undefined : undefined,
                      callbackUrl: mode === 'oauth' ? callback : undefined,
                    }
                  : undefined,
              timeoutMs: Number(timeout),
              enabled,
              isPublic,
              endpoints: scopes,
              multiplier,
              availableModels: available,
            });
        }}
      >
        <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
          <Stack gap="5">
            <FormInput label="名称" value={name} onChange={(e) => setName(e.target.value)} required maxLength={128} />
            <Field.Root>
              <Field.Label>渠道类型</Field.Label>
              <NativeSelect.Root disabled={Boolean(initial)}>
                <NativeSelect.Field
                  aria-label="渠道类型"
                  value={type}
                  onChange={(e) => {
                    setType(e.target.value as typeof type);
                    setScopes(e.target.value === 'subscription' ? [...responsesEndpoints] : []);
                    setAvailable([]);
                    setFetchNotice(undefined);
                  }}
                >
                  <option value="api">API 渠道</option>
                  <option value="subscription">订阅渠道</option>
                  <option value="aggregate" disabled>
                    聚合渠道
                  </option>
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
            </Field.Root>
            {type === 'subscription' ? (
              <Stack gap="5">
                <Field.Root>
                  <Field.Label>订阅平台</Field.Label>
                  <NativeSelect.Root>
                    <NativeSelect.Field aria-label="订阅平台" defaultValue="openai">
                      <option value="openai">OpenAI</option>
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                </Field.Root>
                {initial?.subscription && (
                  <Stack gap="3">
                    <Text fontSize="sm" color="gray.500">
                      访问令牌有效期至 {new Date(initial.subscription.expiresAt).toLocaleString()}，到期前将自动刷新
                    </Text>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      alignSelf="start"
                      disabled={!initial.enabled}
                      loading={renew.isPending}
                      onClick={() => renew.mutate({ channelId: initial.id })}
                    >
                      <RefreshCw size={16} aria-hidden="true" />
                      手动刷新令牌
                    </Button>
                    <ErrorText>{formError(renew.error)?.message}</ErrorText>
                  </Stack>
                )}
                <FormInput
                  label="并发上限"
                  type="number"
                  value={maximum}
                  onChange={(e) => setMaximum(e.target.value)}
                  min={1}
                  max={100}
                  required
                />
                <SelectField
                  label="接入方式"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { id: 'import', name: '导入凭据' },
                    { id: 'oauth', name: 'OAuth 授权' },
                  ]}
                />
                {mode === 'import' ? (
                  <Field.Root>
                    <Field.Label>{initial ? '替换凭据（留空保留）' : '账号凭据'}</Field.Label>
                    <Textarea
                      aria-label="账号凭据"
                      value={credentials}
                      onChange={(e) => setCredentials(e.target.value)}
                      rows={7}
                      maxLength={60000}
                      required={!initial}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Field.HelperText>
                      粘贴 Codex auth.json 或包含 access_token、refresh_token、account_id 和 expires_at 的
                      JSON。凭据加密保存。
                    </Field.HelperText>
                  </Field.Root>
                ) : (
                  <Stack gap="3">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setCallback('');
                        startOAuth.mutate();
                      }}
                      loading={startOAuth.isPending}
                    >
                      生成授权链接
                    </Button>
                    {startOAuth.data && (
                      <Link href={startOAuth.data.url} target="_blank" rel="noreferrer" color="#635bff">
                        打开 OpenAI 授权页面
                      </Link>
                    )}
                    <FormInput
                      label="授权回调地址"
                      value={callback}
                      onChange={(e) => setCallback(e.target.value)}
                      type="url"
                      required
                      autoComplete="off"
                      helper="完成授权后，复制浏览器中完整的 localhost:1455/auth/callback 地址；该页面可能显示无法访问。"
                    />
                  </Stack>
                )}
              </Stack>
            ) : (
              <>
                <FormInput
                  label="Base URL"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  type="url"
                  required
                  helper="支持服务根地址或以 /v1 结尾的 SDK 地址"
                />
                <FormInput
                  label={initial ? '替换凭据（留空保留）' : '上游凭据'}
                  type="password"
                  autoComplete="new-password"
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  required={!initial}
                  maxLength={4096}
                />
              </>
            )}
            <FormInput
              label="超时（毫秒）"
              value={timeout}
              type="number"
              min={100}
              max={600000}
              onChange={(e) => setTimeout(e.target.value)}
              required
            />
            <EndpointFields value={scopes} onChange={setScopes} subscription={type === 'subscription'} />
            <FormInput
              label="整体扣费倍率"
              value={multiplier}
              inputMode="decimal"
              onChange={(e) => setMultiplier(e.target.value)}
              required
              helper="0–1000，最多六位小数；模型专属倍率覆盖此值"
            />
            <ChannelModels
              value={available}
              onChange={setAvailable}
              models={data.models}
              disabled={busy}
              fetching={fetching}
              onFetch={() =>
                type === 'subscription'
                  ? initial
                    ? fetchSubscriptionModels.mutate({ channelId: initial.id })
                    : setFetchError('请先保存订阅渠道，再编辑并拉取模型；也可以直接填写模型名称')
                  : fetchModels.mutate({ id: initial?.id, baseUrl, credential: credential || undefined })
              }
              fetchError={fetchError ?? formError(fetchModels.error ?? fetchSubscriptionModels.error)?.message}
              fetchNotice={fetchNotice}
            />
            <Stack gap="2">
              <Checkbox.Root checked={!isPublic} onCheckedChange={(e) => setIsPublic(!e.checked)}>
                <Checkbox.HiddenInput />
                <Checkbox.Control />
                <Checkbox.Label>非公开渠道</Checkbox.Label>
              </Checkbox.Root>
              <Text fontSize="sm" color="gray.500">
                默认对所有用户开放；非公开渠道需管理员授权模型。
              </Text>
            </Stack>
            <Enabled value={enabled} onChange={setEnabled} />
            <ErrorText>{formError(task.error ?? startOAuth.error)?.message}</ErrorText>
          </Stack>
        </fieldset>
        <HStack mt="5">
          <PrimaryButton
            type="submit"
            loading={task.isPending}
            disabled={fetching || startOAuth.isPending || renew.isPending}
          >
            保存渠道
          </PrimaryButton>
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>
            取消
          </Button>
        </HStack>
      </form>
    </FormDialog>
  );
}
export function ModelForm({
  initial,
  close,
  onSaved,
}: {
  initial?: CatalogData['models'][number];
  close: () => void;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [inputTokenLimit, setInputTokenLimit] = useState(String(initial?.inputTokenLimit ?? 1_000_000));
  const [outputTokenLimit, setOutputTokenLimit] = useState(String(initial?.outputTokenLimit ?? 128_000));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const task = useMutation(
    trpc.admin.catalog.saveModel.mutationOptions({
      onSuccess: async (model) => {
        await refreshCatalog();
        close();
        onSaved(model.id);
      },
    }),
  );
  return (
    <FormDialog open title={initial ? '编辑模型元数据' : '添加模型'} onClose={close} busy={task.isPending}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!task.isPending)
            task.mutate({
              id: initial?.id,
              name,
              enabled,
              inputTokenLimit: Number(inputTokenLimit),
              outputTokenLimit: Number(outputTokenLimit),
            });
        }}
      >
        <Stack gap="5">
          <FormInput label="模型名称" value={name} onChange={(e) => setName(e.target.value)} required maxLength={128} />
          <FormInput
            label="输入 Token 容量"
            type="number"
            min={1}
            required
            value={inputTokenLimit}
            onChange={(e) => setInputTokenLimit(e.target.value)}
            helper="JSON 正文的字节数也不能超过此值"
          />
          <FormInput
            label="输出 Token 上限"
            type="number"
            min={1}
            required
            value={outputTokenLimit}
            onChange={(e) => setOutputTokenLimit(e.target.value)}
          />
          <Enabled value={enabled} onChange={setEnabled} />
          <ErrorText>{formError(task.error)?.message}</ErrorText>
          <HStack>
            <PrimaryButton type="submit" loading={task.isPending}>
              保存模型
            </PrimaryButton>
            <Button variant="ghost" disabled={task.isPending} onClick={close}>
              取消
            </Button>
          </HStack>
        </Stack>
      </form>
    </FormDialog>
  );
}
export default function Catalog() {
  const data = useQuery(trpc.admin.catalog.list.queryOptions());
  const [edit, setEdit] = useState<{ id?: string }>();
  const [saved, setSaved] = useState<RouterOutputs['admin']['catalog']['saveChannel']>();
  const close = () => setEdit(undefined);
  return (
    <Stack gap="7">
      <Title
        action={
          <PrimaryButton
            size="sm"
            onClick={() => {
              setSaved(undefined);
              setEdit({});
            }}
          >
            添加渠道
          </PrimaryButton>
        }
      >
        渠道
      </Title>
      <ErrorText>{formError(data.error)?.message}</ErrorText>
      {saved && saved.unpricedModels.length > 0 && (
        <Stack gap="3" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p="4" role="status">
          <Text fontSize="sm">
            渠道已保存，{saved.unpricedModels.length} 个模型尚未定价。请前往模型页面配置规则或从 models.dev 导入定价。
          </Text>
          <HStack gap="2" flexWrap="wrap">
            {saved.unpricedModels.slice(0, 10).map((model) => (
              <Link key={model.id} asChild>
                <RouterLink to={`/console/models/${model.id}/pricing`}>
                  <Badge colorPalette="gray">{model.name}</Badge>
                </RouterLink>
              </Link>
            ))}
            <Link asChild fontSize="sm" color="#635bff">
              <RouterLink to="/console/models">前往模型页面</RouterLink>
            </Link>
          </HStack>
        </Stack>
      )}
      {data.isPending ? (
        <Loading />
      ) : (
        data.data && (
          <>
            {edit && (
              <ChannelForm
                key={edit.id ?? 'new'}
                initial={data.data.channels.find((c) => c.id === edit.id)}
                data={data.data}
                close={close}
                onSaved={setSaved}
              />
            )}
            <Box overflowX="auto">
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row>
                    {['名称', '类型', '可用模型', '状态', '操作'].map((h) => (
                      <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                    ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.data.channels.map((c) => (
                    <Table.Row key={c.id}>
                      <Table.Cell>
                        <Text>{c.name}</Text>
                        {c.subscription && (
                          <Text fontSize="xs" color="gray.500" overflowWrap="anywhere">
                            {c.subscription.email ?? '未获取邮箱'}
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Text>{channelTypeLabels[c.type]}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Stack gap="2">
                          {c.availableModels.map((a) => (
                            <HStack key={a.modelId} gap="2" flexWrap="wrap">
                              <Text overflowWrap="anywhere">
                                {data.data?.models.find((m) => m.id === a.modelId)?.name}
                              </Text>
                              <Badge colorPalette="gray">{Number(a.multiplier ?? c.multiplier)}×</Badge>
                              {a.multiplier === null && (
                                <Badge colorPalette="gray" fontSize="xs">
                                  继承
                                </Badge>
                              )}
                            </HStack>
                          ))}
                        </Stack>
                      </Table.Cell>
                      <Table.Cell whiteSpace="nowrap">
                        <Stack gap="2" align="start">
                          <Badge colorPalette={c.enabled ? 'green' : 'gray'}>{c.enabled ? '启用' : '禁用'}</Badge>
                          <Badge colorPalette="gray">{c.isPublic ? '公开' : '非公开'}</Badge>
                          {c.subscription && (
                            <>
                              <Badge>
                                并发 {c.subscription.active} / {c.subscription.maxConcurrent}
                              </Badge>
                              {c.subscription.errorCode && <Badge colorPalette="red">需要重新授权</Badge>}
                              {c.subscription.cooldownUntil &&
                                new Date(c.subscription.cooldownUntil).getTime() > Date.now() && (
                                  <Badge colorPalette="orange">限流冷却中</Badge>
                                )}
                            </>
                          )}
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
                        <HStack gap="1" flexWrap="wrap">
                          <IconButton
                            aria-label="编辑渠道"
                            variant="ghost"
                            size="sm"
                            onClick={() => setEdit({ id: c.id })}
                          >
                            <Pencil size={16} aria-hidden="true" />
                          </IconButton>
                          <ConfirmAction
                            label="删除"
                            icon={<Trash2 size={16} aria-hidden="true" />}
                            danger
                            description={`删除渠道「${c.name}」后，绑定它的 Key 将无法发起新请求。历史请求与账单仍然保留。`}
                            action={() => trpcClient.admin.catalog.deleteChannel.mutate({ channelId: c.id })}
                            onSuccess={refreshCatalog}
                          />
                        </HStack>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
            {!data.data.channels.length && (
              <Text fontSize="sm" color="gray.500">
                暂无渠道
              </Text>
            )}
          </>
        )
      )}
    </Stack>
  );
}
