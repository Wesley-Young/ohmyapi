import { Badge, createListCollection, HStack, Select, Stack, Text } from '@chakra-ui/react';
import { useMemo } from 'react';

import type { ModelVendor } from '../lib/model-brands';
import { ChannelVendorIcon } from './brand-icon';

export type ChannelOption = {
  id: string;
  name: string;
  vendor?: ModelVendor;
  badge: string;
  description?: string;
};

export function ChannelSelect({
  label,
  value,
  onChange,
  options,
  disabled,
  hideLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ChannelOption[];
  disabled?: boolean;
  hideLabel?: boolean;
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
      <Select.Label srOnly={hideLabel}>{label}</Select.Label>
      <Select.Control>
        <Select.Trigger>
          <Select.ValueText placeholder="请选择">
            {selected && (
              <HStack gap="2" minW="0">
                <ChannelVendorIcon vendor={selected.vendor} />
                <Text truncate>{selected.name}</Text>
                <Badge flexShrink="0">{selected.badge}</Badge>
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
              <ChannelVendorIcon vendor={option.vendor} />
              <Stack gap="0" minW="0" flex="1">
                <Text truncate>{option.name}</Text>
                {option.description && (
                  <Text fontSize="xs" color="gray.500">
                    {option.description}
                  </Text>
                )}
              </Stack>
              <HStack gap="2" flexShrink="0">
                <Badge>{option.badge}</Badge>
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
