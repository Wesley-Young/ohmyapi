import { Badge, Box, HStack, Link, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Trash2, UserRoundKey } from 'lucide-react';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { ChannelForm } from '../components/channel-form';
import { ChannelUsersDialog } from '../components/channel-grants';
import { IconButton } from '../components/icon-button';
import { PlanBadge } from '../components/plan-badge';
import { SubscriptionQuota } from '../components/subscription-quota';
import { ConfirmAction, ErrorText, Loading, NameAction, PrimaryButton, pinnedColumn, Title } from '../components/ui';
import { refreshCatalog } from '../lib/cache';
import { formError, localDateTime } from '../lib/format';
import { subscriptionProviderLabels } from '../lib/subscription';
import { brandColor } from '../lib/theme';
import { trpc, trpcClient } from '../lib/trpc';

type CatalogData = RouterOutputs['admin']['catalog']['list'];
const channelTypeLabels = {
  api: 'API 渠道',
  subscription: '订阅渠道',
  aggregate: '聚合渠道',
} satisfies Record<CatalogData['channels'][number]['type'], string>;

export default function Channels() {
  const data = useQuery(trpc.admin.catalog.list.queryOptions());
  const [edit, setEdit] = useState<{ id?: string }>();
  const [grantChannel, setGrantChannel] = useState<{ id: string; name: string }>();
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
      {grantChannel && (
        <ChannelUsersDialog
          key={grantChannel.id}
          channelId={grantChannel.id}
          channelName={grantChannel.name}
          onClose={() => setGrantChannel(undefined)}
        />
      )}
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
            <Link asChild fontSize="sm" color={brandColor}>
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
              <Table.Root size="sm" whiteSpace="nowrap">
                <Table.Header>
                  <Table.Row>
                    {['名称', '类型', '扣费倍率', '状态', '额度'].map((h) => (
                      <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                    ))}
                    <Table.ColumnHeader {...pinnedColumn}>操作</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.data.channels.map((c) => (
                    <Table.Row key={c.id}>
                      <Table.Cell>
                        <NameAction aria-haspopup="dialog" onClick={() => setEdit({ id: c.id })}>
                          {c.name}
                        </NameAction>
                      </Table.Cell>
                      <Table.Cell>
                        <HStack gap="2">
                          <Text>
                            {channelTypeLabels[c.type]}{' '}
                            {c.subscription && `(${subscriptionProviderLabels[c.subscription.provider]})`}
                          </Text>
                          {c.type === 'subscription' && c.subscription && (
                            <PlanBadge
                              provider={c.subscription.provider}
                              channelId={c.id}
                              enabled={c.enabled && !c.subscription.errorCode}
                            />
                          )}
                        </HStack>
                        {c.type === 'aggregate' && (
                          <Text fontSize="xs" color="gray.500">
                            {c.members.length} 个子渠道
                          </Text>
                        )}
                        {c.subscription && (
                          <Text fontSize="xs" color="gray.500">
                            {c.subscription.email ?? '未获取邮箱'}
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Stack gap="1" align="start">
                          {c.pricingMode === 'passthrough' ? (
                            <Badge>透传</Badge>
                          ) : (
                            <Badge>{Number(c.multiplier)}×</Badge>
                          )}
                          {c.pricingMode !== 'passthrough' &&
                            c.availableModels.some((model) => model.multiplier !== null) && (
                              <Text fontSize="xs" color="gray.500">
                                {c.availableModels.filter((model) => model.multiplier !== null).length} 个模型有专属倍率
                              </Text>
                            )}
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
                        <Stack gap="2" align="start">
                          <HStack gap="2">
                            <Badge colorPalette={c.enabled ? 'green' : 'gray'}>{c.enabled ? '启用' : '禁用'}</Badge>
                            <Badge colorPalette="gray">{c.isPublic ? '公开' : '非公开'}</Badge>
                          </HStack>
                          {c.subscription && (
                            <>
                              <Badge
                                colorPalette={
                                  c.subscription.active / c.subscription.maxConcurrent >= 0.8
                                    ? 'red'
                                    : c.subscription.active / c.subscription.maxConcurrent >= 0.5
                                      ? 'yellow'
                                      : c.subscription.active > 0
                                        ? 'green'
                                        : 'gray'
                                }
                              >
                                并发 {c.subscription.active} / {c.subscription.maxConcurrent}
                              </Badge>
                              {c.subscription.errorCode && (
                                <Badge colorPalette="red">
                                  {c.subscription.errorCode === 'subscription_refresh_uncertain'
                                    ? '需重新导入凭据'
                                    : '需要重新授权'}
                                </Badge>
                              )}
                              {Object.entries(c.subscription.modelCooldowns)
                                .filter(([, until]) => Date.parse(until) > Date.now())
                                .map(([model, until]) => (
                                  <Badge key={model} colorPalette="orange" title={`恢复时间：${localDateTime(until)}`}>
                                    {model} 冷却中
                                  </Badge>
                                ))}
                              {c.subscription.cooldownUntil &&
                                new Date(c.subscription.cooldownUntil).getTime() > Date.now() && (
                                  <Badge colorPalette="orange">限流冷却中</Badge>
                                )}
                            </>
                          )}
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
                        {c.type === 'subscription' && c.subscription ? (
                          <SubscriptionQuota
                            provider={c.subscription.provider}
                            channelId={c.id}
                            enabled={c.enabled}
                            reauthorizationRequired={!!c.subscription.errorCode}
                          />
                        ) : (
                          <Text color="gray.500">—</Text>
                        )}
                      </Table.Cell>
                      <Table.Cell {...pinnedColumn}>
                        <HStack gap="1">
                          {!c.isPublic && (
                            <IconButton
                              aria-label={`为「${c.name}」授权用户`}
                              title="用户授权"
                              variant="ghost"
                              size="sm"
                              onClick={() => setGrantChannel({ id: c.id, name: c.name })}
                            >
                              <UserRoundKey size={16} aria-hidden="true" />
                            </IconButton>
                          )}
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
