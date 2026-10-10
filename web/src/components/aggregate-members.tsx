import { Badge, Box, Checkbox, Grid, HStack, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

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
          模型和端点取全部子渠道的交集。优先级越大越优先，同优先级按权重分配。
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
                <Checkbox.Label overflowWrap="anywhere">{channel.name}</Checkbox.Label>
              </Checkbox.Root>
              <HStack gap="2" flexWrap="wrap">
                <Badge>{channel.type === 'api' ? 'API 渠道' : '订阅渠道'}</Badge>
                {!channel.enabled && <Badge>已禁用</Badge>}
                {!channel.isPublic && <Badge>非公开</Badge>}
              </HStack>
              {member && (
                <Grid templateColumns="repeat(2, minmax(0, 1fr))" gap="3">
                  <FormInput
                    label={`${channel.name} 优先级`}
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
                    label={`${channel.name} 权重`}
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
