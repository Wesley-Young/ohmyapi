import { Badge, Box, Checkbox, Grid, HStack, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

import { endpoints as allEndpoints, type Endpoint } from '../lib/endpoints';
import type { ChannelModel } from './channel-models';
import { FormInput } from './ui';

type Channel = RouterOutputs['admin']['catalog']['list']['channels'][number];
type Member = Channel['members'][number];

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
  return (
    <Box as="fieldset" minW="0">
      <Text as="legend" fontSize="sm" fontWeight="500" mb="2">
        子渠道
      </Text>
      <Stack gap="3">
        <Text fontSize="sm" color="gray.500">
          模型和端点取全部子渠道的交集；优先级越大越优先调用该渠道，同优先级内按权重分流；上游未执行请求时依次换用其他子渠道。
        </Text>
        {candidates.map((channel) => {
          const member = value.find((entry) => entry.channelId === channel.id);
          return (
            <Stack key={channel.id} gap="3" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p="3">
              <Checkbox.Root
                checked={Boolean(member)}
                onCheckedChange={(event) =>
                  onChange(
                    event.checked === true
                      ? [...value, { channelId: channel.id, priority: 0, weight: 1 }]
                      : value.filter((entry) => entry.channelId !== channel.id),
                  )
                }
              >
                <Checkbox.HiddenInput />
                <Checkbox.Control />
                <Checkbox.Label overflowWrap="anywhere">
                  <HStack gap="2" flexWrap="wrap">
                    {channel.name}
                    <Badge>{channel.type === 'api' ? 'API 渠道' : '订阅渠道'}</Badge>
                    {!channel.enabled && <Badge>已禁用</Badge>}
                    {!channel.isPublic && <Badge>非公开</Badge>}
                  </HStack>
                </Checkbox.Label>
              </Checkbox.Root>

              {member && (
                <Grid templateColumns="repeat(2, minmax(0, 1fr))" gap="3">
                  <FormInput
                    label="优先级"
                    type="number"
                    min={0}
                    max={1000}
                    required
                    value={String(member.priority ?? 0)}
                    onChange={(event) =>
                      onChange(
                        value.map((entry) =>
                          entry.channelId === channel.id ? { ...entry, priority: Number(event.target.value) } : entry,
                        ),
                      )
                    }
                  />
                  <FormInput
                    label="权重"
                    type="number"
                    min={1}
                    max={1000}
                    required
                    value={String(member.weight ?? 1)}
                    onChange={(event) =>
                      onChange(
                        value.map((entry) =>
                          entry.channelId === channel.id ? { ...entry, weight: Number(event.target.value) } : entry,
                        ),
                      )
                    }
                  />
                </Grid>
              )}
            </Stack>
          );
        })}
        {!candidates.length && (
          <Text fontSize="sm" color="gray.500">
            请先创建 API 或订阅渠道。
          </Text>
        )}
        {candidates.some((channel) => !channel.isPublic && value.some((member) => member.channelId === channel.id)) && (
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
