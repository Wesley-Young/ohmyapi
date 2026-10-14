import { Box, Button, Checkbox, Field, HStack, NativeSelect, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { refreshCatalog } from '../lib/cache';
import { type Endpoint, endpoints, responsesEndpoints } from '../lib/endpoints';
import { formError } from '../lib/format';
import type { SubscriptionProvider } from '../lib/subscription';
import { trpc } from '../lib/trpc';
import { AggregateMembers, AggregateSummary, aggregateCommon } from './aggregate-members';
import { type ChannelModel, ChannelModels } from './channel-models';
import { EnabledField, SelectField } from './fields';
import { SubscriptionAccess, type SubscriptionAccessMode, SubscriptionAccount } from './subscription-access';
import { ErrorText, FormDialog, FormInput, PrimaryButton } from './ui';

type CatalogData = RouterOutputs['admin']['catalog']['list'];

function EndpointFields({
  value,
  onChange,
  subscription = false,
  provider = 'openai',
}: {
  value: Endpoint[];
  onChange: (value: Endpoint[]) => void;
  subscription?: boolean;
  provider?: SubscriptionProvider;
}) {
  return (
    <Box as="fieldset">
      <Text as="legend" fontSize="sm" fontWeight="500" mb="2">
        支持的端点
      </Text>
      <Stack gap="3">
        {endpoints
          .filter(
            (endpoint) =>
              endpoint !== '/v1/responses/compact' &&
              (!subscription || endpoint === (provider === 'claude' ? '/v1/messages' : '/v1/responses')),
          )
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

export function ChannelForm({
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
  const [pricingMode, setPricingMode] = useState(initial?.pricingMode ?? 'unified');
  const passthrough = type === 'aggregate' && pricingMode === 'passthrough';
  const [members, setMembers] = useState<CatalogData['channels'][number]['members']>(initial?.members ?? []);
  const [maximum, setMaximum] = useState(String(initial?.subscription?.maxConcurrent ?? 5));
  const [provider, setProvider] = useState<SubscriptionProvider>(initial?.subscription?.provider ?? 'openai');
  const [mode, setMode] = useState<SubscriptionAccessMode>('oauth');
  const [credentials, setCredentials] = useState('');
  const [callback, setCallback] = useState('');
  const [resetCreditBusy, setResetCreditBusy] = useState(false);
  const startOAuth = useMutation(trpc.admin.catalog.startSubscriptionOAuth.mutationOptions());
  const renew = useMutation(
    trpc.admin.catalog.refreshSubscription.mutationOptions({
      onSuccess: refreshCatalog,
      onError: refreshCatalog,
    }),
  );
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [proxyUrl, setProxyUrl] = useState(initial?.proxyUrl ?? '');
  const proxyInput = proxyUrl.trim() || null;
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
  const { commonEndpoints, commonModels } = aggregateCommon(members, data, available);
  const [fetchNotice, setFetchNotice] = useState<string>();
  const [fetchError, setFetchError] = useState<string>();
  const fetchOptions = {
    onMutate: () => {
      setFetchNotice(undefined);
      setFetchError(undefined);
    },
    onSuccess: (result: { names: string[]; ignored: number; unavailable?: number }) => {
      const additions = result.names.filter((name) => !available.some((model) => model.name === name));
      if (available.length + additions.length > 1000) {
        setFetchError('合并后超过 1000 个模型，请先移除部分模型');
        return;
      }
      setAvailable([...available, ...additions.map((name) => ({ name, multiplier: null }))]);
      setFetchNotice(
        `已拉取 ${result.names.length} 个模型，新增 ${additions.length} 个${result.ignored ? `，忽略 ${result.ignored} 个无效条目` : ''}${result.unavailable ? `，跳过 ${result.unavailable} 个不可选模型` : ''}`,
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
  const busy = task.isPending || fetching || startOAuth.isPending || renew.isPending || resetCreditBusy;
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
              pricingMode: type === 'aggregate' ? pricingMode : 'unified',
              baseUrl: type === 'api' ? baseUrl : undefined,
              proxyUrl: type === 'aggregate' ? undefined : proxyInput,
              credential: type === 'api' ? credential || undefined : undefined,
              subscription:
                type === 'subscription'
                  ? {
                      provider,
                      maxConcurrent: Number(maximum),
                      credentials: mode === 'import' ? credentials || undefined : undefined,
                      callbackUrl: mode === 'oauth' ? callback || undefined : undefined,
                    }
                  : undefined,
              timeoutMs: Number(timeout),
              enabled,
              isPublic,
              endpoints: type === 'aggregate' ? [] : scopes,
              members: type === 'aggregate' ? members : [],
              multiplier: passthrough ? undefined : multiplier,
              availableModels: passthrough ? undefined : type === 'aggregate' ? commonModels : available,
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
                    setScopes(
                      e.target.value === 'subscription'
                        ? provider === 'claude'
                          ? ['/v1/messages']
                          : [...responsesEndpoints]
                        : [],
                    );
                    setAvailable([]);
                    setFetchNotice(undefined);
                  }}
                >
                  <option value="api">API 渠道</option>
                  <option value="subscription">订阅渠道</option>
                  <option value="aggregate">聚合渠道</option>
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
            </Field.Root>
            {type === 'aggregate' ? (
              <AggregateMembers value={members} onChange={setMembers} channels={data.channels} />
            ) : type === 'subscription' ? (
              <Stack gap="5">
                <Field.Root>
                  <Field.Label>订阅平台</Field.Label>
                  <NativeSelect.Root disabled={!!initial || busy}>
                    <NativeSelect.Field
                      aria-label="订阅平台"
                      value={provider}
                      onChange={(e) => {
                        const next = e.target.value === 'claude' ? 'claude' : 'openai';
                        setProvider(next);
                        setMode('oauth');
                        startOAuth.reset();
                        setCredentials('');
                        setCallback('');
                        setAvailable([]);
                        setScopes(next === 'claude' ? ['/v1/messages'] : [...responsesEndpoints]);
                      }}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="claude">Claude</option>
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                </Field.Root>
                {initial?.subscription && (
                  <SubscriptionAccount
                    channel={initial}
                    subscription={initial.subscription}
                    refreshing={renew.isPending}
                    refreshError={renew.error}
                    onRefresh={() => renew.mutate({ channelId: initial.id })}
                    onResetCreditBusyChange={setResetCreditBusy}
                  />
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
                <SubscriptionAccess
                  provider={provider}
                  editing={Boolean(initial)}
                  busy={busy}
                  mode={mode}
                  onModeChange={setMode}
                  credentials={credentials}
                  onCredentialsChange={setCredentials}
                  callback={callback}
                  onCallbackChange={setCallback}
                  oauthUrl={startOAuth.data?.url}
                  oauthPending={startOAuth.isPending}
                  onStartOAuth={() => {
                    setCallback('');
                    startOAuth.reset();
                    startOAuth.mutate({ provider });
                  }}
                />
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
                  label={initial ? '替换凭据（留空保留现有凭据）' : '上游凭据'}
                  type="password"
                  autoComplete="new-password"
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  required={!initial}
                  maxLength={4096}
                />
              </>
            )}
            {type !== 'aggregate' && (
              <FormInput
                label="代理地址"
                type="url"
                autoComplete="off"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="http://user:password@host:port"
                maxLength={4096}
                error={
                  formError(task.error ?? fetchModels.error ?? fetchSubscriptionModels.error)?.fields.proxyUrl?.[0]
                }
                helper="支持 HTTP(S) 及用户名密码认证，留空直连。"
              />
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
            {type === 'aggregate' ? (
              <AggregateSummary endpoints={commonEndpoints} hasModels={commonModels.length > 0} />
            ) : (
              <EndpointFields
                value={scopes}
                onChange={setScopes}
                subscription={type === 'subscription'}
                provider={provider}
              />
            )}
            {type === 'aggregate' && (
              <Stack gap="2">
                <SelectField
                  label="计费模式"
                  value={pricingMode}
                  onChange={(value) => setPricingMode(value === 'passthrough' ? 'passthrough' : 'unified')}
                  options={[
                    { id: 'unified', name: '统一倍率' },
                    { id: 'passthrough', name: '透传倍率' },
                  ]}
                />
                {passthrough && (
                  <Text fontSize="sm" color="gray.500">
                    按实际子渠道的模型专属倍率或整体倍率扣费。
                  </Text>
                )}
              </Stack>
            )}
            {!passthrough && (
              <FormInput
                label="整体扣费倍率"
                value={multiplier}
                inputMode="decimal"
                onChange={(e) => setMultiplier(e.target.value)}
                required
                helper="0–1000，最多六位小数；模型专属倍率覆盖此值"
              />
            )}
            <ChannelModels
              derived={type === 'aggregate'}
              editableMultipliers={!passthrough}
              value={type === 'aggregate' ? commonModels : available}
              onChange={setAvailable}
              models={data.models}
              disabled={busy}
              fetching={fetching}
              onFetch={() =>
                type === 'subscription'
                  ? fetchSubscriptionModels.mutate({
                      channelId: initial?.id,
                      provider,
                      proxyUrl: proxyInput,
                      credentials: mode === 'import' ? credentials || undefined : undefined,
                      callbackUrl: mode === 'oauth' ? callback || undefined : undefined,
                    })
                  : fetchModels.mutate({
                      id: initial?.id,
                      baseUrl,
                      credential: credential || undefined,
                      proxyUrl: proxyInput,
                    })
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
                默认对所有用户开放；非公开渠道需管理员授权可访问用户。
              </Text>
            </Stack>
            <EnabledField value={enabled} onChange={setEnabled} />
            <ErrorText>{formError(task.error ?? startOAuth.error)?.message}</ErrorText>
          </Stack>
        </fieldset>
        <HStack mt="5">
          <PrimaryButton
            type="submit"
            loading={task.isPending}
            disabled={
              fetching ||
              startOAuth.isPending ||
              renew.isPending ||
              (type === 'aggregate' &&
                (!members.length || (enabled && (!commonModels.length || !commonEndpoints.length))))
            }
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
