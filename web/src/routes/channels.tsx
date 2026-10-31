import { Badge, Box, Grid, Heading, HStack, Link, Menu, Portal, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  ChevronRight,
  CircleAlert,
  Ellipsis,
  Layers,
  Lock,
  Pencil,
  Plug,
  ShieldCheck,
  Trash2,
  UserRoundKey,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { ModelIcon, ProviderIcon } from '../components/brand-icon';
import { ChannelForm } from '../components/channel-form';
import { ChannelUsersDialog } from '../components/channel-grants';
import { IconButton, Tooltip } from '../components/icon-button';
import { PlanBadge } from '../components/plan-badge';
import { SubscriptionQuota } from '../components/subscription-quota';
import { ConfirmAction, ErrorText, Loading, Metric, NameAction, PrimaryButton, Title } from '../components/ui';
import { refreshCatalog } from '../lib/cache';
import { type ChannelType, channelTypeLabels } from '../lib/channels';
import { displayAmount, formError, localDateTime } from '../lib/format';
import { ppmToPercent } from '../lib/moderation';
import { brandColor, textColor } from '../lib/theme';
import { trpc, trpcClient } from '../lib/trpc';

type Catalog = RouterOutputs['admin']['catalog']['list'];
type Channel = Catalog['channels'][number];
type Spending = RouterOutputs['admin']['channelSpending']['channels'][number];

// 分节顺序与后端的渠道排序一致；节内保持后端顺序（需要重新授权的在前，其次启用的）。
const sectionOrder = ['aggregate', 'api', 'subscription'] as const satisfies readonly ChannelType[];

type Member = { channel: Channel; priority: number; weight: number };

const coolingDown = (until: string | null) => !!until && Date.parse(until) > Date.now();

/** 渠道的健康状态，以类型图标上的状态点表示。 */
function channelStatus(c: Channel): { color: string; label: string } {
  if (!c.enabled) return { color: 'gray.300', label: '已禁用' };
  const sub = c.subscription;
  if (sub?.errorCode)
    return {
      color: 'red.500',
      label: sub.errorCode === 'subscription_refresh_uncertain' ? '需重新导入凭据' : '需要重新授权',
    };
  if (sub && (coolingDown(sub.cooldownUntil) || Object.values(sub.modelCooldowns).some(coolingDown)))
    return { color: 'orange.400', label: '冷却中' };
  return { color: 'green.500', label: '已启用' };
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
  if (sub.cooldownUntil && coolingDown(sub.cooldownUntil))
    notices.push({ key: 'cooldown', tone: 'orange', text: `限流冷却中，${localDateTime(sub.cooldownUntil)} 恢复` });
  for (const [model, until] of Object.entries(sub.modelCooldowns))
    if (coolingDown(until))
      notices.push({ key: `model:${model}`, tone: 'orange', text: `${model} 冷却中，${localDateTime(until)} 恢复` });
  return notices;
}

function StatusDot({ color, ring }: { color: string; ring: string }) {
  return <Box boxSize="2.5" flexShrink="0" borderRadius="full" bg={color} borderWidth="2px" borderColor={ring} />;
}

function ChannelIcon({ channel: c }: { channel: Channel }) {
  const status = channelStatus(c);
  return (
    <Box
      position="relative"
      color="gray.500"
      display="flex"
      flexShrink="0"
      role="img"
      aria-label={status.label}
      title={status.label}
    >
      {c.subscription ? (
        <ProviderIcon provider={c.subscription.provider} />
      ) : c.type === 'aggregate' ? (
        <Layers size={16} aria-hidden="true" />
      ) : (
        <Plug size={16} aria-hidden="true" />
      )}
      <Box position="absolute" right="-3px" bottom="-3px">
        <StatusDot color={status.color} ring={c.enabled ? 'white' : 'gray.50'} />
      </Box>
    </Box>
  );
}

/** 很少变动的配置，以名称后的小图标表示，悬停或聚焦时显示详情。 */
function Attribute({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip content={label}>
      <Box
        as="span"
        tabIndex={0}
        role="img"
        aria-label={label}
        display="inline-flex"
        flexShrink="0"
        color="gray.400"
        borderRadius="sm"
        _focusVisible={{ outline: `2px solid ${brandColor}`, outlineOffset: '2px' }}
      >
        {children}
      </Box>
    </Tooltip>
  );
}

function ChannelAttributes({ channel: c, modelNames }: { channel: Channel; modelNames: Map<string, string> }) {
  const mappedModels = c.availableModels.filter((model) => model.upstreamModel !== null);
  const { samplePpm, dailyFloor, includeOutput } = c.moderation;
  const moderation = [
    samplePpm > 0 && `抽样 ${ppmToPercent(samplePpm)}%`,
    dailyFloor > 0 && `每用户每天保底 ${dailyFloor} 个 session`,
    includeOutput && '含模型输出',
  ].filter(Boolean);
  return (
    <>
      {!c.isPublic && (
        <Attribute label="非公开，仅授权用户可用">
          <Lock size={14} aria-hidden="true" />
        </Attribute>
      )}
      {(samplePpm > 0 || dailyFloor > 0) && (
        <Attribute label={`内容审计：${moderation.join('，')}`}>
          <ShieldCheck size={14} aria-hidden="true" />
        </Attribute>
      )}
      {mappedModels.length > 0 && (
        <Attribute
          label={`上游模型名：${mappedModels
            .map((model) => `${modelNames.get(model.modelId) ?? model.modelId} → ${model.upstreamModel}`)
            .join('、')}`}
        >
          <ArrowLeftRight size={14} aria-hidden="true" />
        </Attribute>
      )}
    </>
  );
}

/** 进行中的请求数；有上限时附占用条，按占用比例着色。 */
function ConcurrencyMetric({ active, maximum }: { active: number; maximum: number | null }) {
  const ratio = maximum === null ? 0 : active / maximum;
  return (
    <Metric
      label="并发"
      meter={
        maximum === null
          ? undefined
          : {
              value: ratio * 100,
              color: ratio >= 0.8 ? 'red.500' : ratio >= 0.5 ? 'yellow.500' : 'green.500',
              label: '并发占用',
            }
      }
    >
      {active}
      {maximum !== null && (
        <Text as="span" fontSize="xs" fontWeight="400" color="gray.500">
          / {maximum}
        </Text>
      )}
    </Metric>
  );
}

/** 扣费倍率；模型专属倍率折叠为数量，悬停查看。 */
function MultiplierMetric({ channel: c, modelNames }: { channel: Channel; modelNames: Map<string, string> }) {
  if (c.pricingMode === 'passthrough') return <Metric label="倍率">透传</Metric>;
  const specialModels = c.availableModels.filter((model) => model.multiplier !== null);
  return (
    <Metric label="倍率">
      {Number(c.multiplier)}×
      {specialModels.length > 0 && (
        <Tooltip
          content={`模型专属倍率：${specialModels
            .map((model) => `${modelNames.get(model.modelId) ?? model.modelId} ${Number(model.multiplier)}×`)
            .join('、')}`}
        >
          <Text as="span" tabIndex={0} fontSize="xs" fontWeight="400" color="gray.500" borderRadius="sm">
            +{specialModels.length} 个模型
          </Text>
        </Tooltip>
      )}
    </Metric>
  );
}

/** 子渠道按优先级从高到低排成故障转移链；同一优先级按权重分流。 */
function MemberChain({ members }: { members: Member[] }) {
  if (!members.length)
    return (
      <Metric label="子渠道" gridColumn={{ base: 'span 2', lg: 'span 3' }}>
        <Text as="span" fontWeight="400" color="gray.500">
          无
        </Text>
      </Metric>
    );
  const tiers = [...new Set(members.map((member) => member.priority))]
    .sort((a, b) => b - a)
    .map((priority) => members.filter((member) => member.priority === priority));
  return (
    <Metric label="子渠道" gridColumn={{ base: 'span 2', lg: 'span 3' }}>
      <HStack as="ol" gap="1.5" rowGap="1" flexWrap="wrap" minW="0" listStyleType="none" fontWeight="400">
        {tiers.map((tier, index) => (
          <HStack as="li" key={tier[0].priority} gap="1.5" aria-label={`优先级 ${tier[0].priority}`}>
            {index > 0 && <ChevronRight size={14} color="var(--chakra-colors-gray-400)" aria-hidden="true" />}
            <HStack gap="3" flexWrap="wrap" rowGap="1">
              {tier.map(({ channel, weight }) => {
                const status = channelStatus(channel);
                return (
                  <HStack
                    key={channel.id}
                    gap="1.5"
                    minW="0"
                    color={channel.enabled ? undefined : 'gray.400'}
                    title={status.label}
                  >
                    <StatusDot color={status.color} ring="transparent" />
                    <Text as="span" truncate>
                      {channel.name}
                    </Text>
                    {tier.length > 1 && (
                      <Text as="span" fontSize="xs" color="gray.500">
                        权重 {weight}
                      </Text>
                    )}
                  </HStack>
                );
              })}
            </HStack>
          </HStack>
        ))}
      </HStack>
    </Metric>
  );
}

function ChannelActions({
  channel: c,
  onEdit,
  onGrant,
}: {
  channel: Channel;
  onEdit: () => void;
  onGrant: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <Menu.Root
        positioning={{ placement: 'bottom-end' }}
        onSelect={({ value }) => {
          if (value === 'edit') onEdit();
          else if (value === 'grant') onGrant();
          else if (value === 'delete') setDeleting(true);
        }}
      >
        <Menu.Trigger asChild>
          <IconButton aria-label={`「${c.name}」的操作`} title="操作" variant="ghost" size="sm" color="gray.600">
            <Ellipsis size={16} aria-hidden="true" />
          </IconButton>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="160px" borderRadius="xl">
              <Menu.Item value="edit" borderRadius="lg">
                <Pencil size={14} aria-hidden="true" />
                编辑
              </Menu.Item>
              {!c.isPublic && (
                <Menu.Item value="grant" borderRadius="lg">
                  <UserRoundKey size={14} aria-hidden="true" />
                  用户授权
                </Menu.Item>
              )}
              <Menu.Item value="delete" borderRadius="lg" color="red.600" _highlighted={{ bg: 'red.50' }}>
                <Trash2 size={14} aria-hidden="true" />
                删除
              </Menu.Item>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
      <ConfirmAction
        open={deleting}
        onClose={() => setDeleting(false)}
        label="删除"
        danger
        description={`删除渠道「${c.name}」后，绑定它的 Key 将无法发起新请求。历史请求与账单仍然保留。`}
        action={() => trpcClient.admin.catalog.deleteChannel.mutate({ channelId: c.id })}
        onSuccess={refreshCatalog}
      />
    </>
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
  members: Member[];
  spending: { currency: string; channel: Spending | undefined } | undefined;
  modelNames: Map<string, string>;
  onEdit: () => void;
  onGrant: () => void;
}) {
  const notices = channelNotices(c);
  const subtitle = c.subscription ? (c.subscription.email ?? '（未获取邮箱）') : c.baseUrl;
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
        templateColumns={{ base: 'minmax(0, 1fr) auto', lg: 'minmax(0, 260px) minmax(0, 1fr) auto' }}
        templateAreas={{ base: `"identity actions" "metrics metrics"`, lg: `"identity metrics actions"` }}
        columnGap={{ base: '3', lg: '8' }}
        rowGap="4"
        px="5"
        py="4"
        alignItems="center"
      >
        <Stack gridArea="identity" gap="1" minW="0">
          <HStack gap="2" minW="0">
            <ChannelIcon channel={c} />
            <NameAction
              aria-haspopup="dialog"
              fontSize="md"
              fontWeight="600"
              color={c.enabled ? textColor : 'gray.500'}
              flexShrink="1"
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
            <ChannelAttributes channel={c} modelNames={modelNames} />
          </HStack>
          {subtitle && (
            <Text fontSize="xs" color="gray.500" truncate title={subtitle}>
              {subtitle}
            </Text>
          )}
        </Stack>

        <Grid
          gridArea="metrics"
          templateColumns={{ base: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' }}
          columnGap="6"
          rowGap="4"
          alignItems="start"
        >
          {c.type === 'api' && (
            <>
              <ConcurrencyMetric active={c.active} maximum={c.maxConcurrent} />
              <MultiplierMetric channel={c} modelNames={modelNames} />
              {[
                { label: '近 24 小时', value: spending?.channel?.last24Hours },
                { label: '近 30 天', value: spending?.channel?.last30Days },
              ].map(({ label, value }) => (
                <Metric key={label} label={label}>
                  {spending ? displayAmount(value ?? '0', spending.currency) : '—'}
                </Metric>
              ))}
            </>
          )}
          {c.subscription && (
            <>
              <SubscriptionQuota
                provider={c.subscription.provider}
                channelId={c.id}
                enabled={c.enabled}
                reauthorizationRequired={!!c.subscription.errorCode}
              />
              <ConcurrencyMetric active={c.subscription.active} maximum={c.subscription.maxConcurrent} />
              <MultiplierMetric channel={c} modelNames={modelNames} />
            </>
          )}
          {c.type === 'aggregate' && (
            <>
              <MemberChain members={members} />
              <MultiplierMetric channel={c} modelNames={modelNames} />
            </>
          )}
        </Grid>

        <Box gridArea="actions" alignSelf={{ base: 'start', lg: 'center' }}>
          <ChannelActions channel={c} onEdit={onEdit} onGrant={onGrant} />
        </Box>
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
                members={c.members.flatMap((member) => {
                  const channel = byId.get(member.channelId);
                  return channel ? [{ channel, priority: member.priority, weight: member.weight }] : [];
                })}
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
