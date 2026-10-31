import { Badge, createListCollection, HStack, Select, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMemo } from 'react';

import { channelTypeLabels } from '../lib/channels';
import { displayMultiplier } from '../lib/format';

type AvailableChannel = RouterOutputs['keys']['channels'][number];

/** 下拉选项：可用渠道，或已绑定但当前不可用的渠道。 */
export type ChannelOption =
  | Pick<AvailableChannel, 'id' | 'name' | 'type' | 'pricingMode' | 'multiplier' | 'multiplierRange'>
  | { id: string; name: string; unavailable: true };

function ChannelBadge({ channel }: { channel: ChannelOption }) {
  if ('unavailable' in channel) return <Badge colorPalette="gray">不可用</Badge>;
  return (
    <Badge flexShrink="0">
      {channel.multiplierRange
        ? displayMultiplier(channel.multiplierRange.minimum, channel.multiplierRange.maximum)
        : displayMultiplier(channel.multiplier)}
    </Badge>
  );
}

/** 选择 Key 绑定的渠道，选项按渠道页面的顺序展示名称和整体扣费倍率；透传倍率显示子渠道的倍率区间。 */
export function ChannelSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ChannelOption[];
  disabled?: boolean;
}) {
  const collection = useMemo(
    () =>
      createListCollection({
        items: options,
        itemToValue: (item) => item.id,
        itemToString: (item) => item.name,
      }),
    [options],
  );
  const selected = options.find((option) => option.id === value);
  return (
    <Select.Root
      collection={collection}
      value={value ? [value] : []}
      onValueChange={(e) => onChange(e.value[0] ?? '')}
      disabled={disabled}
      positioning={{ sameWidth: true, strategy: 'fixed' }}
    >
      <Select.HiddenSelect />
      <Select.Label>{label}</Select.Label>
      <Select.Control>
        <Select.Trigger>
          <Select.ValueText placeholder="请选择">
            {selected && (
              <HStack gap="2" minW="0">
                <Text truncate>{selected.name}</Text>
                <ChannelBadge channel={selected} />
              </HStack>
            )}
          </Select.ValueText>
        </Select.Trigger>
        <Select.IndicatorGroup>
          <Select.Indicator />
        </Select.IndicatorGroup>
      </Select.Control>
      <Select.Positioner>
        <Select.Content maxH="min(320px, var(--available-height))" overflowY="auto">
          {collection.items.map((option) => (
            <Select.Item key={option.id} item={option} gap="3" py="2">
              <Stack gap="0" minW="0" flex="1">
                <Text truncate>{option.name}</Text>
                {'type' in option && (
                  <Text fontSize="xs" color="gray.500">
                    {channelTypeLabels[option.type]}
                    {option.pricingMode === 'passthrough' && '（透传倍率）'}
                  </Text>
                )}
              </Stack>
              <HStack gap="2" flexShrink="0">
                <ChannelBadge channel={option} />
                <Select.ItemIndicator />
              </HStack>
            </Select.Item>
          ))}
          {!options.length && (
            <Text px="2" py="1.5" fontSize="sm" color="gray.500">
              暂无可用渠道
            </Text>
          )}
        </Select.Content>
      </Select.Positioner>
    </Select.Root>
  );
}
