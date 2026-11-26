import { Badge, Box, Button, Checkbox, Field, Grid, HStack, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';

import { refreshCatalog } from '../lib/cache';
import { channelTypeLabels } from '../lib/channels';
import { type Endpoint, endpointProtocolNames, endpoints } from '../lib/endpoints';
import { formError } from '../lib/format';
import { percentToPpm, ppmToPercent } from '../lib/moderation';
import { isSubscriptionProvider, type SubscriptionProvider, subscriptionProviderLabels } from '../lib/subscription';
import { trpc } from '../lib/trpc';
import { AggregateMembers, aggregateCapabilities } from './aggregate-members';
import { ProviderIcon } from './brand-icon';
import { ChannelDialog, ChannelDisclosure, ChannelMultiplierField, ChannelVisibility } from './channel-form-layout';
import { type ChannelModel, ChannelModels, channelModel, channelModelsInput } from './channel-models';
import { SubscriptionAccess, type SubscriptionAccessMode, SubscriptionAccount } from './subscription-access';
import { ErrorText, FormInput } from './ui';
import { type FetchedModels, UpstreamImport } from './upstream-import';
import { ViewSwitch } from './view-switch';

type CatalogData = RouterOutputs['admin']['catalog']['list'];

const subscriptionPlatforms = Object.keys(subscriptionProviderLabels)
  .filter(isSubscriptionProvider)
  .map((value) => ({
    value,
    label: (
      <HStack as="span" gap="1">
        <ProviderIcon provider={value} size={14} />
        {subscriptionProviderLabels[value]}
      </HStack>
    ),
  }));

function EndpointFields({
  value,
  onChange,
  options,
}: {
  value: Endpoint[];
  onChange: (value: Endpoint[]) => void;
  options: readonly Endpoint[];
}) {
  return (
    <HStack gap="2" flexWrap="wrap">
      {options.map((endpoint) => (
        <Checkbox.Root
          key={endpoint}
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="lg"
          px="3"
          py="2"
          checked={value.includes(endpoint)}
          onCheckedChange={(e) =>
            onChange(e.checked === true ? [...value, endpoint] : value.filter((item) => item !== endpoint))
          }
        >
          <Checkbox.HiddenInput data-channel-error={!value.length ? '请选择至少一个端点' : undefined} />
          <Checkbox.Control />
          <Checkbox.Label title={endpoint} fontSize="sm">
            {endpointProtocolNames[endpoint]}
          </Checkbox.Label>
        </Checkbox.Root>
      ))}
    </HStack>
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
  const [channelMaximum, setChannelMaximum] = useState(String(initial?.maxConcurrent ?? ''));
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
  const [replacingCredential, setReplacingCredential] = useState(false);
  const [credential, setCredential] = useState('');
  const [timeout, setTimeout] = useState(String(initial?.timeoutMs ?? 120000));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [isPublic, setIsPublic] = useState(initial?.isPublic ?? true);
  const [scopes, setScopes] = useState<Endpoint[]>(initial?.endpoints ?? []);
  const [multiplier, setMultiplier] = useState(initial?.multiplier ?? '1');
  const [samplePercent, setSamplePercent] = useState(ppmToPercent(initial?.moderation.samplePpm ?? 0));
  const [dailyFloor, setDailyFloor] = useState(String(initial?.moderation.dailyFloor ?? 0));
  const [includeOutput, setIncludeOutput] = useState(initial?.moderation.includeOutput ?? false);
  const samplePpm = percentToPpm(samplePercent);
  const [available, setAvailable] = useState<ChannelModel[]>(
    initial?.availableModels.flatMap((entry) => {
      const model = data.models.find((model) => model.id === entry.modelId);
      return model
        ? [
            {
              ...channelModel(model.name, entry.upstreamModel, entry.reasoningEffortRules),
              multiplier: entry.multiplier,
            },
          ]
        : [];
    }) ?? [],
  );
  const { aggregateEndpoints, aggregateModels } = aggregateCapabilities(members, data, available);
  const [fetchNotice, setFetchNotice] = useState<string>();
  // 最近一次拉取的结果：导入列表关闭后仍用于标记上游未返回的模型。
  const [fetched, setFetched] = useState<{ id: number; result: FetchedModels; open: boolean }>();
  const resetModels = () => {
    setAvailable([]);
    setFetched(undefined);
    setFetchNotice(undefined);
  };
  const fetchOptions = {
    onMutate: () => {
      setFetchNotice(undefined);
    },
    onSuccess: (result: FetchedModels) => setFetched({ id: Date.now(), result, open: true }),
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
  const selectedEndpoints = type === 'aggregate' ? aggregateEndpoints : scopes;
  const auditSummary =
    [Number(samplePercent) > 0 && `抽样 ${samplePercent}%`, Number(dailyFloor) > 0 && `每天保底 ${dailyFloor} 个会话`]
      .filter(Boolean)
      .join('，') || '未启用抽样';
  const membersError = !members.length
    ? '请选择至少一个子渠道'
    : enabled && (!aggregateModels.length || !aggregateEndpoints.length)
      ? '请选择提供模型和端点的子渠道'
      : undefined;
  return (
    <ChannelDialog
      creating={!initial}
      close={close}
      enabled={enabled}
      onEnabledChange={setEnabled}
      busy={busy}
      saving={task.isPending}
      error={formError(task.error)?.message}
      onSave={() =>
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
          maxConcurrent: type === 'api' ? (channelMaximum.trim() ? Number(channelMaximum) : null) : undefined,
          enabled,
          isPublic,
          endpoints: type === 'aggregate' ? [] : scopes,
          members: type === 'aggregate' ? members : [],
          multiplier: passthrough ? undefined : multiplier,
          moderation:
            samplePpm === undefined ? undefined : { samplePpm, dailyFloor: Number(dailyFloor), includeOutput },
          availableModels: passthrough
            ? undefined
            : type === 'aggregate'
              ? aggregateModels.map(({ name, multiplier }) => ({ name, multiplier }))
              : channelModelsInput(available),
        })
      }
      panels={{
        access: (
          <Stack gap="5">
            <Grid
              gap="4"
              templateColumns={!initial ? { base: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) auto' } : undefined}
            >
              <FormInput
                label="渠道名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={128}
              />
              {!initial && (
                <Field.Root>
                  <Field.Label>渠道类型</Field.Label>
                  <ViewSwitch
                    label="渠道类型"
                    items={(['api', 'subscription', 'aggregate'] as const).map((value) => ({
                      value,
                      label: channelTypeLabels[value],
                    }))}
                    value={type}
                    disabled={busy}
                    onChange={(next) => {
                      setType(next);
                      setScopes(next === 'subscription' ? [data.subscriptionEndpoints[provider]] : []);
                      setDailyFloor(next === 'subscription' ? '1' : '0');
                      resetModels();
                    }}
                  />
                </Field.Root>
              )}
            </Grid>
            {type === 'aggregate' ? (
              <Box tabIndex={-1} data-channel-error={membersError}>
                <AggregateMembers value={members} onChange={setMembers} channels={data.channels} />
              </Box>
            ) : type === 'subscription' ? (
              <>
                {initial?.subscription ? (
                  <Field.Root>
                    <Field.Label>订阅账号</Field.Label>
                    <HStack borderWidth="1px" borderRadius="lg" p="3" w="full">
                      <ProviderIcon provider={provider} />
                      <Text fontWeight="500">{subscriptionProviderLabels[provider]}</Text>
                      {initial.subscription.email && (
                        <Text fontSize="sm" overflowWrap="anywhere" minW="0" color="gray.600">
                          {initial.subscription.email}
                        </Text>
                      )}
                    </HStack>
                  </Field.Root>
                ) : (
                  <Field.Root
                    css={{ '& [data-scope=segment-group][data-part=item]': { px: { base: '1.5', sm: '4' } } }}
                  >
                    <Field.Label>订阅平台</Field.Label>
                    <ViewSwitch
                      label="订阅平台"
                      items={subscriptionPlatforms}
                      value={provider}
                      disabled={!!initial || busy}
                      onChange={(next) => {
                        setProvider(next);
                        setMode('oauth');
                        startOAuth.reset();
                        setCredentials('');
                        setCallback('');
                        resetModels();
                        setScopes([data.subscriptionEndpoints[next]]);
                      }}
                    />
                  </Field.Root>
                )}
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

                <ErrorText>{formError(startOAuth.error)?.message}</ErrorText>
              </>
            ) : (
              <>
                <FormInput
                  label="Base URL"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  type="url"
                  required
                  helper="支持服务根地址或以 /v1、/v1beta 结尾的 SDK 地址"
                />

                {initial && (
                  <Field.Root>
                    <Field.Label>上游凭据</Field.Label>
                    <HStack w="full" borderWidth="1px" px="3" py="1" borderRadius="lg">
                      <KeyRound size={15} aria-hidden="true" />
                      <Text flex="1" fontSize="sm">
                        已配置凭据
                      </Text>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-expanded={replacingCredential}
                        onClick={() => {
                          setReplacingCredential(!replacingCredential);
                          setCredential('');
                        }}
                      >
                        {replacingCredential ? '取消更换' : '更换凭据'}
                      </Button>
                    </HStack>
                  </Field.Root>
                )}
                {(!initial || replacingCredential) && (
                  <FormInput
                    label={initial ? '新凭据' : '上游凭据'}
                    type="password"
                    autoComplete="new-password"
                    value={credential}
                    onChange={(e) => setCredential(e.target.value)}
                    required={!initial}
                    maxLength={4096}
                  />
                )}
              </>
            )}
            <ChannelDisclosure
              title="支持端点"
              summary={
                type === 'aggregate'
                  ? `从子渠道继承 ${selectedEndpoints.length} 项`
                  : `已选 ${selectedEndpoints.length} 项`
              }
              defaultOpen={true}
            >
              {type === 'aggregate' ? (
                <HStack gap="2" flexWrap="wrap">
                  {selectedEndpoints.map((ep) => (
                    <Badge key={ep} title={ep}>
                      {endpointProtocolNames[ep]}
                    </Badge>
                  ))}
                  {!selectedEndpoints.length && (
                    <Text fontSize="sm" color="gray.500">
                      请先选择提供端点的子渠道。
                    </Text>
                  )}
                </HStack>
              ) : (
                <EndpointFields
                  value={scopes}
                  onChange={setScopes}
                  options={type === 'subscription' ? [data.subscriptionEndpoints[provider]] : endpoints}
                />
              )}
            </ChannelDisclosure>
          </Stack>
        ),
        models: (
          <Stack gap="5">
            {type === 'aggregate' && (
              <Field.Root>
                <Field.Label>计费模式</Field.Label>
                <ViewSwitch
                  label="计费模式"
                  value={pricingMode}
                  onChange={setPricingMode}
                  disabled={busy}
                  items={[
                    { value: 'unified', label: '统一倍率' },
                    { value: 'passthrough', label: '透传倍率' },
                  ]}
                />
                <Field.HelperText>
                  {passthrough ? '使用实际承接请求的子渠道倍率。' : '使用聚合渠道设置的倍率。'}
                </Field.HelperText>
              </Field.Root>
            )}
            {!passthrough && <ChannelMultiplierField overall value={multiplier} onChange={setMultiplier} />}
            <ChannelModels
              derived={type === 'aggregate'}
              editableMultipliers={!passthrough}
              value={type === 'aggregate' ? aggregateModels : available}
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
              fetchError={formError(fetchModels.error ?? fetchSubscriptionModels.error)?.message}
              fetchNotice={fetchNotice}
              upstreamNames={fetched ? new Set(fetched.result.names) : undefined}
              importPanel={
                fetched?.open && (
                  <UpstreamImport
                    key={fetched.id}
                    result={fetched.result}
                    rows={available}
                    models={data.models}
                    disabled={busy}
                    onAdd={(rows) => {
                      setAvailable([...available, ...rows]);
                      setFetched({ ...fetched, open: false });
                      setFetchNotice(`已加入 ${rows.length} 个模型`);
                    }}
                    onCancel={() => setFetched({ ...fetched, open: false })}
                  />
                )
              }
            />
          </Stack>
        ),
        policy: (
          <Stack gap="5">
            <Text as="h3" fontWeight="600">
              请求设置
            </Text>
            <Grid gap="4" templateColumns={{ base: 'minmax(0,1fr)', sm: 'repeat(2,minmax(0,1fr))' }}>
              <FormInput
                label="超时（毫秒）"
                value={timeout}
                type="number"
                min={100}
                max={600000}
                onChange={(e) => setTimeout(e.target.value)}
                required
              />
              {type === 'subscription' && (
                <FormInput
                  label="并发上限"
                  type="number"
                  value={maximum}
                  onChange={(e) => setMaximum(e.target.value)}
                  min={1}
                  max={100}
                  required
                />
              )}
              {type === 'api' && (
                <FormInput
                  label="并发上限"
                  type="number"
                  value={channelMaximum}
                  onChange={(e) => setChannelMaximum(e.target.value)}
                  min={1}
                  max={1000}
                  placeholder="不限"
                  helper="留空不限，最多 1000"
                />
              )}
            </Grid>
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

            <Box borderTopWidth="1px" pt="4">
              <ChannelVisibility isPublic={isPublic} onChange={setIsPublic} disabled={busy} />
            </Box>
            <ChannelDisclosure title="内容审计" summary={auditSummary}>
              <Stack gap="4">
                <FormInput
                  label="抽样比例（%）"
                  data-channel-error={samplePpm === undefined ? '请输入有效的抽样比例' : undefined}
                  value={samplePercent}
                  inputMode="decimal"
                  onChange={(e) => setSamplePercent(e.target.value)}
                  required
                  error={samplePpm === undefined ? '请输入 0–100，最多四位小数' : undefined}
                  helper="按 session 抽样送审，0 表示不按比例抽样"
                />
                <FormInput
                  label="每用户每天保底"
                  type="number"
                  value={dailyFloor}
                  onChange={(e) => setDailyFloor(e.target.value)}
                  min={0}
                  max={100}
                  required
                  helper="用户当天审计的 session 少于此数时，抽取其后续会话；0 表示不保底"
                />
                <Checkbox.Root checked={includeOutput} onCheckedChange={(e) => setIncludeOutput(e.checked === true)}>
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label>送审内容包含模型输出</Checkbox.Label>
                </Checkbox.Root>
              </Stack>
            </ChannelDisclosure>
          </Stack>
        ),
        maintenance: initial?.subscription && (
          <SubscriptionAccount
            channel={initial}
            subscription={initial.subscription}
            refreshing={renew.isPending}
            refreshError={renew.error}
            onRefresh={() => renew.mutate({ channelId: initial.id })}
            onResetCreditBusyChange={setResetCreditBusy}
          />
        ),
      }}
    />
  );
}
