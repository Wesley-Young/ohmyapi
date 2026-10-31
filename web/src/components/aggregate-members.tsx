import { Badge, Box, Button, Grid, HStack, Input, Menu, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { Lock, Plus, X } from 'lucide-react';

import { channelTypeLabels } from '../lib/channels';
import { endpoints as allEndpoints, type Endpoint } from '../lib/endpoints';
import { displayMultiplier } from '../lib/format';
import { ChannelIcon } from './channel-icon';
import type { ChannelModel } from './channel-models';
import { IconButton } from './icon-button';
import { Attribute } from './ui';

type Channel = RouterOutputs['admin']['catalog']['list']['channels'][number];
type Member = Channel['members'][number];

const memberColumns = 'minmax(0, 1fr) 4.5rem 4.5rem auto';

/** 已选子渠道逐行编辑优先级和权重，其余候选渠道从「添加子渠道」菜单中按类型选择。 */
export function AggregateMembers({
  value,
  onChange,
  channels,
}: {
  value: Member[];
  onChange: (value: Member[]) => void;
  channels: Channel[];
}) {
  const candidates = channels.filter((channel) => channel.type !== 'aggregate');
  const selected = value.flatMap((member) => {
    const channel = candidates.find((candidate) => candidate.id === member.channelId);
    return channel ? [{ member, channel }] : [];
  });
  const remaining = candidates.filter((channel) => !value.some((member) => member.channelId === channel.id));
  const update = (channelId: string, patch: Partial<Member>) =>
    onChange(value.map((entry) => (entry.channelId === channelId ? { ...entry, ...patch } : entry)));
  return (
    <Box as="fieldset" minW="0">
      <Text as="legend" fontSize="sm" fontWeight="500" mb="2">
        子渠道
      </Text>
      <Stack gap="3">
        <Text fontSize="sm" color="gray.500">
          模型和端点取全部子渠道的交集；优先级越大越优先调用该渠道，同优先级内按权重分流；上游未执行请求时依次换用其他子渠道。
        </Text>
        {selected.length > 0 && (
          <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" px="3">
            <Grid
              templateColumns={memberColumns}
              columnGap="2"
              py="2"
              fontSize="xs"
              color="gray.500"
              aria-hidden="true"
            >
              <Text>渠道</Text>
              <Text>优先级</Text>
              <Text>权重</Text>
              <Box w="6" />
            </Grid>
            <Box as="ul" listStyleType="none">
              {selected.map(({ member, channel }) => (
                <Grid
                  as="li"
                  key={channel.id}
                  templateColumns={memberColumns}
                  columnGap="2"
                  alignItems="center"
                  py="2"
                  borderTopWidth="1px"
                  borderColor="gray.100"
                >
                  <HStack gap="2" minW="0">
                    <ChannelIcon channel={channel} />
                    <Text fontSize="sm" truncate title={channel.name} color={channel.enabled ? undefined : 'gray.500'}>
                      {channel.name}
                    </Text>
                    <Badge flexShrink="0">{displayMultiplier(channel.multiplier)}</Badge>
                    {!channel.isPublic && (
                      <Attribute label="非公开，仅授权用户可用">
                        <Lock size={14} aria-hidden="true" />
                      </Attribute>
                    )}
                  </HStack>
                  <Input
                    size="sm"
                    type="number"
                    min={0}
                    max={1000}
                    required
                    aria-label={`${channel.name}的优先级`}
                    value={String(member.priority ?? 0)}
                    onChange={(event) => update(channel.id, { priority: Number(event.target.value) })}
                  />
                  <Input
                    size="sm"
                    type="number"
                    min={1}
                    max={1000}
                    required
                    aria-label={`${channel.name}的权重`}
                    value={String(member.weight ?? 1)}
                    onChange={(event) => update(channel.id, { weight: Number(event.target.value) })}
                  />
                  <IconButton
                    aria-label={`移除${channel.name}`}
                    size="xs"
                    variant="ghost"
                    color="gray.500"
                    onClick={() => onChange(value.filter((entry) => entry.channelId !== channel.id))}
                  >
                    <X size={14} aria-hidden="true" />
                  </IconButton>
                </Grid>
              ))}
            </Box>
          </Box>
        )}
        {candidates.length ? (
          <Menu.Root
            positioning={{ placement: 'bottom-start', strategy: 'fixed' }}
            onSelect={({ value: channelId }) => onChange([...value, { channelId, priority: 0, weight: 1 }])}
          >
            <Menu.Trigger asChild>
              <Button size="sm" variant="outline" alignSelf="start" disabled={!remaining.length}>
                <Plus size={14} aria-hidden="true" />
                {remaining.length ? '添加子渠道' : '已添加全部渠道'}
              </Button>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content
                minW="240px"
                maxW="min(360px, var(--available-width))"
                maxH="min(320px, var(--available-height))"
                overflowY="auto"
                borderRadius="xl"
              >
                {(['api', 'subscription'] as const).map((type) => {
                  const items = remaining.filter((channel) => channel.type === type);
                  return (
                    items.length > 0 && (
                      <Menu.ItemGroup key={type}>
                        <Menu.ItemGroupLabel fontSize="xs" fontWeight="500" color="gray.500">
                          {channelTypeLabels[type]}
                        </Menu.ItemGroupLabel>
                        {items.map((channel) => (
                          <Menu.Item key={channel.id} value={channel.id} gap="2" borderRadius="lg">
                            <ChannelIcon channel={channel} />
                            <Text truncate color={channel.enabled ? undefined : 'gray.500'}>
                              {channel.name}
                            </Text>
                            {!channel.isPublic && (
                              <Box
                                as="span"
                                display="inline-flex"
                                flexShrink="0"
                                color="gray.400"
                                role="img"
                                aria-label="非公开"
                              >
                                <Lock size={14} aria-hidden="true" />
                              </Box>
                            )}
                            <Badge flexShrink="0" ms="auto">
                              {displayMultiplier(channel.multiplier)}
                            </Badge>
                          </Menu.Item>
                        ))}
                      </Menu.ItemGroup>
                    )
                  );
                })}
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
        ) : (
          <Text fontSize="sm" color="gray.500">
            请先创建 API 或订阅渠道。
          </Text>
        )}
        {selected.some(({ channel }) => !channel.isPublic) && (
          <Text fontSize="sm" color="gray.600">
            获准使用此聚合渠道的用户，也可以通过它调用所选非公开子渠道。
          </Text>
        )}
      </Stack>
    </Box>
  );
}

type CatalogData = RouterOutputs['admin']['catalog']['list'];

/** 聚合渠道继承所选子渠道共同支持的端点和模型；模型保留已设置的专属倍率。 */
export function aggregateCommon(members: Member[], data: CatalogData, available: ChannelModel[]) {
  const selectedChannels = members.flatMap((member) =>
    data.channels.filter((channel) => channel.id === member.channelId),
  );
  const commonEndpoints = selectedChannels.length
    ? allEndpoints.filter((endpoint) => selectedChannels.every((channel) => channel.endpoints.includes(endpoint)))
    : [];
  const commonModels = selectedChannels.length
    ? data.models
        .filter((model) =>
          selectedChannels.every((channel) => channel.availableModels.some((entry) => entry.modelId === model.id)),
        )
        .map((model) => ({
          key: model.id,
          name: model.name,
          multiplier: available.find((entry) => entry.name === model.name)?.multiplier ?? null,
        }))
    : [];
  return { commonEndpoints, commonModels };
}

export function AggregateSummary({ endpoints, hasModels }: { endpoints: Endpoint[]; hasModels: boolean }) {
  return (
    <Stack gap="2">
      <Text fontSize="sm" fontWeight="500">
        支持端点
      </Text>
      <HStack gap="2" flexWrap="wrap">
        {endpoints.map((endpoint) => (
          <Badge key={endpoint}>{endpoint}</Badge>
        ))}
      </HStack>
      {(!endpoints.length || !hasModels) && (
        <Text fontSize="sm" color="gray.500">
          请选择至少有一个共同模型和共同端点的子渠道。
        </Text>
      )}
    </Stack>
  );
}
