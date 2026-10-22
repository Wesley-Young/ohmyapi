import { Badge, Box, Grid, Heading, HStack, Link, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Layers, Lock, Pencil, Plug, Trash2, UserRoundKey } from 'lucide-react';
import { Fragment, type ReactNode, useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { ModelIcon, ProviderIcon } from '../components/brand-icon';
import { ChannelForm } from '../components/channel-form';
import { ChannelUsersDialog } from '../components/channel-grants';
import { IconButton, Tooltip } from '../components/icon-button';
import { PlanBadge } from '../components/plan-badge';
import { SubscriptionQuota } from '../components/subscription-quota';
import { ConfirmAction, ErrorText, Loading, NameAction, PrimaryButton, Title } from '../components/ui';
import { refreshCatalog } from '../lib/cache';
import { type ChannelType, channelTypeLabels } from '../lib/channels';
import { displayAmount, formError, localDateTime } from '../lib/format';
import { brandColor } from '../lib/theme';
import { trpc, trpcClient } from '../lib/trpc';

type Catalog = RouterOutputs['admin']['catalog']['list'];
type Channel = Catalog['channels'][number];
type Spending = RouterOutputs['admin']['channelSpending']['channels'][number];

// 分节顺序与后端的渠道排序一致；节内保持后端顺序（需要重新授权的在前，其次启用的）。
const sectionOrder = ['aggregate', 'api', 'subscription'] as const satisfies readonly ChannelType[];

/** 进行中的请求数；有上限时按占用比例着色。 */
function ConcurrencyBadge({ active, maximum }: { active: number; maximum: number | null }) {
  const ratio = maximum === null ? 0 : active / maximum;
  return (
    <Badge colorPalette={ratio >= 0.8 ? 'red' : ratio >= 0.5 ? 'yellow' : active > 0 ? 'green' : 'gray'}>
      并发 {active}
      {maximum !== null && ` / ${maximum}`}
    </Badge>
  );
}

/** 渠道名称组成的徽标组；禁用的渠道以浅色显示。 */
function ChannelBadges({ channels }: { channels: Channel[] }) {
  return (
    <HStack gap="1.5" flexWrap="wrap" minW="0">
      {channels.map((c) => (
        <Badge
          key={c.id}
          colorPalette="gray"
          color={c.enabled ? undefined : 'gray.400'}
          title={c.enabled ? undefined : '已禁用'}
        >
          {c.type === 'api' && <Plug size={12} aria-hidden="true" />}
          {c.type === 'aggregate' && <Layers size={12} aria-hidden="true" /> /* unreachable */}
          {c.subscription && <ProviderIcon provider={c.subscription.provider} size={12} />}
          {c.name}
        </Badge>
      ))}
    </HStack>
  );
}

/** 卡片中栏的一行：左侧固定宽度的标签，右侧内容。 */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <HStack gap="3" align="start" minW="0">
      <Text fontSize="xs" color="gray.500" w="10" flexShrink="0" lineHeight="20px">
        {label}
      </Text>
      {children}
    </HStack>
  );
}

/** 需要处理的异常，以通栏提示显示在卡片底部。 */
function channelNotices(c: Channel) {
  const notices: { key: string; tone: 'red' | 'orange'; text: string }[] = [];
  const sub = c.subscription;
  if (!sub) return notices;
  if (sub.errorCode)
    notices.push({
      key: 'error',
      tone: 'red',
      text: sub.errorCode === 'subscription_refresh_uncertain' ? '需重新导入凭据' : '需要重新授权',
    });
  if (sub.cooldownUntil && Date.parse(sub.cooldownUntil) > Date.now())
    notices.push({ key: 'cooldown', tone: 'orange', text: `限流冷却中，${localDateTime(sub.cooldownUntil)} 恢复` });
  for (const [model, until] of Object.entries(sub.modelCooldowns))
    if (Date.parse(until) > Date.now())
      notices.push({ key: `model:${model}`, tone: 'orange', text: `${model} 冷却中，${localDateTime(until)} 恢复` });
  return notices;
}

function ChannelIcon({ channel: c }: { channel: Channel }) {
  return (
    <Box color="gray.500" display="flex" flexShrink="0">
      {c.subscription ? (
        <ProviderIcon provider={c.subscription.provider} />
      ) : c.type === 'aggregate' ? (
        <Layers size={16} aria-hidden="true" />
      ) : (
        <Plug size={16} aria-hidden="true" />
      )}
    </Box>
  );
}

/** 实际落到该渠道上的扣费，与 API Key 页面的消费列一致。 */
function ChannelSpending({ spending, currency }: { spending: Spending | undefined; currency: string }) {
  return (
    <Grid
      as="dl"
      templateColumns="auto auto"
      columnGap="3"
      rowGap="1.5"
      justifyContent="start"
      fontSize="xs"
      lineHeight="20px"
      fontVariantNumeric="tabular-nums"
    >
      {[
        { label: '近 24 小时', value: spending?.last24Hours ?? '0' },
        { label: '近 30 天', value: spending?.last30Days ?? '0' },
      ].map(({ label, value }) => (
        <Fragment key={label}>
          <Text as="dt" color="gray.500">
            {label}
          </Text>
          <Text as="dd" color="gray.700" fontWeight="500">
            {displayAmount(value, currency)}
          </Text>
        </Fragment>
      ))}
    </Grid>
  );
}

function ChannelCard({
  channel: c,
  members,
  spending,
  modelNames,
  onEdit,
  onGrant,
}: {
  channel: Channel;
  members: Channel[];
  spending: { currency: string; channel: Spending | undefined } | undefined;
  modelNames: Map<string, string>;
  onEdit: () => void;
  onGrant: () => void;
}) {
  const specialModels = c.availableModels.filter((model) => model.multiplier !== null);
  const multiplier = Number(c.multiplier);
  const notices = channelNotices(c);
  return (
    <Box
      as="article"
      aria-label={c.name}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="xl"
      bg={c.enabled ? 'white' : 'gray.50'}
      overflow="hidden"
    >
      <Grid
        templateColumns={{ base: 'minmax(0, 1fr) auto', lg: 'minmax(220px, 1fr) minmax(0, 2fr) auto' }}
        templateAreas={{ base: `"identity actions" "details details"`, lg: `"identity details actions"` }}
        columnGap="6"
        rowGap="4"
        px="5"
        py="4"
        alignItems="center"
      >
        <Stack gridArea="identity" gap="1.5" minW="0" align="start">
          <HStack gap="2" minW="0" maxW="full" flexWrap="wrap">
            <ChannelIcon channel={c} />
            <NameAction
              aria-haspopup="dialog"
              fontSize="md"
              fontWeight="600"
              color={c.enabled ? '#171717' : 'gray.500'}
              onClick={onEdit}
            >
              {c.name}
            </NameAction>
            {c.subscription && (
              <PlanBadge
                provider={c.subscription.provider}
                channelId={c.id}
                enabled={c.enabled && !c.subscription.errorCode}
              />
            )}
          </HStack>
          {c.subscription ? (
            <Text fontSize="xs" color="gray.500" maxW="full" truncate>
              {c.subscription.email ?? '（未获取邮箱）'}
            </Text>
          ) : (
            c.baseUrl && (
              <Text fontSize="xs" color="gray.500" maxW="full" truncate title={c.baseUrl}>
                {c.baseUrl}
              </Text>
            )
          )}
          <HStack gap="1.5" flexWrap="wrap" _empty={{ display: 'none' }}>
            {!c.enabled && <Badge colorPalette="gray">已禁用</Badge>}
            {!c.isPublic && (
              <Badge colorPalette="gray">
                <Lock size={12} aria-hidden="true" />
                非公开
              </Badge>
            )}
            {c.pricingMode === 'passthrough' ? (
              <Badge>透传</Badge>
            ) : (
              (multiplier !== 1 || specialModels.length > 0) && <Badge title="扣费倍率">{multiplier}×</Badge>
            )}
            {c.pricingMode !== 'passthrough' && specialModels.length > 0 && (
              <Tooltip
                content={specialModels
                  .map((model) => `${modelNames.get(model.modelId) ?? model.modelId} ${Number(model.multiplier)}×`)
                  .join('、')}
              >
                <Badge tabIndex={0}>{specialModels.length} 个模型专属倍率</Badge>
              </Tooltip>
            )}
            {c.type === 'api' && (c.maxConcurrent !== null || c.active > 0) && (
              <ConcurrencyBadge active={c.active} maximum={c.maxConcurrent} />
            )}
            {c.subscription && (
              <ConcurrencyBadge active={c.subscription.active} maximum={c.subscription.maxConcurrent} />
            )}
          </HStack>
        </Stack>

        {(c.type !== 'api' || spending) && (
          <Stack gridArea="details" gap="3" minW="0">
            {c.type === 'api' && spending && (
              <ChannelSpending spending={spending.channel} currency={spending.currency} />
            )}
            {c.type === 'aggregate' && (
              <DetailRow label="子渠道">
                {members.length ? (
                  <ChannelBadges channels={members} />
                ) : (
                  <Text fontSize="xs" color="gray.500" lineHeight="20px">
                    无
                  </Text>
                )}
              </DetailRow>
            )}
            {c.subscription && (
              <SubscriptionQuota
                provider={c.subscription.provider}
                channelId={c.id}
                enabled={c.enabled}
                reauthorizationRequired={!!c.subscription.errorCode}
              />
            )}
          </Stack>
        )}

        <HStack gridArea="actions" gap="1" alignSelf={{ base: 'start', lg: 'center' }}>
          {c.isPublic ? (
            // 占位保持各卡片的操作按钮对齐。
            <Box w="8" flexShrink="0" aria-hidden="true" />
          ) : (
            <IconButton
              aria-label={`为「${c.name}」授权用户`}
              title="用户授权"
              variant="ghost"
              size="sm"
              onClick={onGrant}
            >
              <UserRoundKey size={16} aria-hidden="true" />
            </IconButton>
          )}
          <IconButton aria-label="编辑渠道" variant="ghost" size="sm" onClick={onEdit}>
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
      </Grid>
      {notices.length > 0 && (
        <Stack gap="0" borderTopWidth="1px" borderColor="gray.100" role="status">
          {notices.map((notice) => (
            <HStack
              key={notice.key}
              gap="2"
              px="5"
              py="2"
              bg={`${notice.tone}.50`}
              color={`${notice.tone}.700`}
              fontSize="xs"
            >
              <CircleAlert size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              <Text>{notice.text}</Text>
            </HStack>
          ))}
        </Stack>
      )}
    </Box>
  );
}

function ChannelList({
  catalog,
  onEdit,
  onGrant,
}: {
  catalog: Catalog;
  onEdit: (id: string) => void;
  onGrant: (channel: Channel) => void;
}) {
  const byId = new Map(catalog.channels.map((c) => [c.id, c]));
  const modelNames = new Map(catalog.models.map((m) => [m.id, m.name]));
  const spending = useQuery(trpc.admin.channelSpending.queryOptions()).data;
  const spendingByChannel = new Map(spending?.channels.map((row) => [row.channelId, row]));
  const sections = sectionOrder
    .map((type) => ({ type, channels: catalog.channels.filter((c) => c.type === type) }))
    .filter((section) => section.channels.length > 0);
  return (
    <Stack gap="8">
      {sections.map((section) => (
        <Stack key={section.type} as="section" gap="3" aria-labelledby={`channels-${section.type}`}>
          <Heading as="h2" id={`channels-${section.type}`} fontSize="md" fontWeight="600" color="#171717">
            {channelTypeLabels[section.type]}{' '}
            <Text as="span" color="gray.500" fontWeight="400">
              ({section.channels.length})
            </Text>
          </Heading>
          <Stack gap="3">
            {section.channels.map((c) => (
              <ChannelCard
                key={c.id}
                channel={c}
                members={c.members.flatMap((member) => byId.get(member.channelId) ?? [])}
                spending={spending && { currency: spending.currency, channel: spendingByChannel.get(c.id) }}
                modelNames={modelNames}
                onEdit={() => onEdit(c.id)}
                onGrant={() => onGrant(c)}
              />
            ))}
          </Stack>
        </Stack>
      ))}
    </Stack>
  );
}

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
                  <Badge colorPalette="gray">
                    <ModelIcon model={model.name} size={12} />
                    {model.name}
                  </Badge>
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
            <ChannelList
              catalog={data.data}
              onEdit={(id) => setEdit({ id })}
              onGrant={(c) => setGrantChannel({ id: c.id, name: c.name })}
            />
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
