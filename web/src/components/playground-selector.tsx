import { Button, Flex, HStack, Input, Popover, Portal, Stack, Text } from '@chakra-ui/react';
import { Check, ChevronDown, RefreshCw, X } from 'lucide-react';
import { useRef, useState } from 'react';

import { displayMultiplier } from '../lib/format';
import type { ModelVendor } from '../lib/model-brands';
import type { PlaygroundChannel, PlaygroundModel } from '../lib/playground';
import { ChannelVendorIcon, ModelIcon, ModelLabel } from './brand-icon';
import { IconButton } from './icon-button';

export function PlaygroundSelector({
  channels,
  vendors,
  selectedChannel,
  selectedModel,
  disabled,
  refreshing,
  onRefresh,
  onSelect,
}: {
  channels: PlaygroundChannel[];
  vendors?: ReadonlyMap<string, ModelVendor | undefined>;
  selectedChannel?: PlaygroundChannel;
  selectedModel?: PlaygroundModel;
  disabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onSelect: (channel: PlaygroundChannel, model: PlaygroundModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftChannelId, setDraftChannelId] = useState('');
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const draftChannel = channels.find((channel) => channel.id === draftChannelId);
  const models = draftChannel?.models.filter((model) => model.name.toLowerCase().includes(search.trim().toLowerCase()));

  const selectionLabel = selectedChannel && selectedModel ? `${selectedChannel.name}/${selectedModel.name}` : undefined;

  return (
    <Popover.Root
      open={open && !disabled}
      onOpenChange={({ open: nextOpen }) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setDraftChannelId(selectedChannel?.id ?? channels[0]?.id ?? '');
          setSearch('');
        }
      }}
      positioning={{ placement: 'top-start', strategy: 'fixed', gutter: 12, shift: 12 }}
      initialFocusEl={() => searchInput.current}
      lazyMount
      unmountOnExit
    >
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          borderRadius="full"
          flexShrink="1"
          minW="0"
          maxW={{ base: '160px', sm: '300px' }}
          disabled={disabled}
          aria-label={selectionLabel ? `选择渠道和模型，当前为 ${selectionLabel}` : '选择渠道和模型'}
          title={selectionLabel ?? '选择渠道和模型'}
        >
          {selectedModel && <ModelIcon model={selectedModel.name} />}
          <Text truncate>{selectionLabel ?? '选择渠道和模型'}</Text>
          <ChevronDown size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            w="min(600px, calc(100vw - 24px))"
            h="400px"
            maxH="min(65dvh, var(--available-height, 65dvh))"
            minH="0"
            borderRadius="2xl"
            bg="white"
            borderColor="gray.200"
            boxShadow="0 8px 32px rgba(0, 0, 0, 0.12)"
            overflow="hidden"
            pointerEvents="auto"
          >
            <HStack px="4" py="3" justify="space-between" flexShrink="0" borderBottomWidth="1px" borderColor="gray.100">
              <Popover.Title fontSize="sm" fontWeight="600">
                选择渠道和模型
              </Popover.Title>
              <HStack gap="1">
                <IconButton
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label="刷新渠道和模型"
                  loading={refreshing}
                  onClick={onRefresh}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                </IconButton>
                <Popover.CloseTrigger asChild>
                  <IconButton type="button" variant="ghost" size="xs" aria-label="关闭模型选择">
                    <X size={16} aria-hidden="true" />
                  </IconButton>
                </Popover.CloseTrigger>
              </HStack>
            </HStack>
            <Flex flex="1" minH="0">
              <Stack
                w={{ base: '104px', sm: '180px' }}
                flexShrink="0"
                gap="2"
                p={{ base: 2, sm: 3 }}
                bg="gray.50"
                borderRightWidth="1px"
                borderColor="gray.100"
              >
                <Text fontSize="xs" color="gray.500" px="2">
                  渠道
                </Text>
                <Stack gap="1" overflowY="auto" minH="0" aria-label="渠道列表">
                  {channels.map((channel) => (
                    <Button
                      key={channel.id}
                      type="button"
                      variant="ghost"
                      h="auto"
                      minH="48px"
                      px="2"
                      py="2"
                      flexShrink="0"
                      justifyContent="flex-start"
                      gap="1.5"
                      borderRadius="lg"
                      bg={draftChannel?.id === channel.id ? 'gray.200' : 'transparent'}
                      aria-pressed={draftChannel?.id === channel.id}
                      onClick={() => {
                        setDraftChannelId(channel.id);
                        setSearch('');
                      }}
                    >
                      <ChannelVendorIcon vendor={vendors?.get(channel.id)} />
                      <Text
                        flex="1"
                        minW="0"
                        fontSize="sm"
                        whiteSpace="normal"
                        overflowWrap="anywhere"
                        textAlign="left"
                      >
                        {channel.name}
                      </Text>
                      {draftChannel?.id === channel.id && (
                        <Check size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
                      )}
                    </Button>
                  ))}
                  {!channels.length && (
                    <Text fontSize="xs" color="gray.500" px="2">
                      暂无可用渠道
                    </Text>
                  )}
                </Stack>
              </Stack>
              <Stack flex="1" minW="0" minH="0" gap="2" p={{ base: 2, sm: 3 }}>
                <Input
                  ref={searchInput}
                  aria-label="搜索模型"
                  placeholder="搜索模型…"
                  size="sm"
                  borderRadius="full"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  flexShrink="0"
                />
                <Stack gap="1" overflowY="auto" minH="0" aria-label="模型列表">
                  {models?.map((model) => (
                    <Button
                      key={model.id}
                      type="button"
                      variant="ghost"
                      justifyContent="space-between"
                      h="auto"
                      minH="36px"
                      flexShrink="0"
                      px="3"
                      py="2"
                      borderRadius="lg"
                      bg={
                        selectedChannel?.id === draftChannel?.id && selectedModel?.id === model.id
                          ? 'gray.100'
                          : 'transparent'
                      }
                      aria-pressed={selectedChannel?.id === draftChannel?.id && selectedModel?.id === model.id}
                      onClick={() => {
                        if (!draftChannel) return;
                        onSelect(draftChannel, model);
                        setOpen(false);
                      }}
                    >
                      <Text fontSize="sm" fontWeight="500" whiteSpace="normal" overflowWrap="anywhere" textAlign="left">
                        <ModelLabel model={model.name} />
                      </Text>
                      <Text as="span" fontSize="xs" color="gray.500" ms="auto">
                        {displayMultiplier(model.minimum, model.maximum)}
                      </Text>
                      {selectedChannel?.id === draftChannel?.id && selectedModel?.id === model.id && (
                        <Check size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
                      )}
                    </Button>
                  ))}
                  {!models?.length && (
                    <Text fontSize="sm" color="gray.500" p="3">
                      {draftChannel ? '没有匹配的模型' : '请选择渠道'}
                    </Text>
                  )}
                </Stack>
              </Stack>
            </Flex>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
