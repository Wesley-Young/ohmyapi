import { Button, Menu, Portal, Text } from '@chakra-ui/react';
import { ChevronDown } from 'lucide-react';

import { endpointProtocolNames } from '../lib/endpoints';
import type { PlaygroundEndpoint } from '../lib/playground';

/** Key 提供多种对话协议时选择本次使用的协议。 */
export function PlaygroundProtocol({
  endpoints,
  value,
  disabled,
  onChange,
}: {
  endpoints: PlaygroundEndpoint[];
  value: PlaygroundEndpoint;
  disabled: boolean;
  onChange: (endpoint: PlaygroundEndpoint) => void;
}) {
  return (
    <Menu.Root positioning={{ placement: 'top-end', strategy: 'fixed', gutter: 12 }}>
      <Menu.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          borderRadius="full"
          color="gray.600"
          minW="0"
          disabled={disabled}
          aria-label={`选择协议，当前为 ${endpointProtocolNames[value]}`}
          title="选择协议"
        >
          <Text truncate>{endpointProtocolNames[value]}</Text>
          <ChevronDown size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="180px" borderRadius="xl">
            <Menu.RadioItemGroup
              value={value}
              onValueChange={({ value: next }) => {
                const endpoint = endpoints.find((item) => item === next);
                if (endpoint) onChange(endpoint);
              }}
            >
              <Menu.ItemGroupLabel fontSize="xs" color="gray.500">
                协议
              </Menu.ItemGroupLabel>
              {endpoints.map((endpoint) => (
                <Menu.RadioItem key={endpoint} value={endpoint} borderRadius="lg">
                  <Menu.ItemText>{endpointProtocolNames[endpoint]}</Menu.ItemText>
                  <Menu.ItemIndicator />
                </Menu.RadioItem>
              ))}
            </Menu.RadioItemGroup>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
