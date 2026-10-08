import { Box, Button, Flex, HStack, IconButton, Input, Popover, Portal, Stack, Text } from '@chakra-ui/react';
import { Check, ChevronDown, RefreshCw, X } from 'lucide-react';
import { useRef, useState } from 'react';

import type { PlaygroundKey, PlaygroundModel } from '../lib/playground';

export function PlaygroundSelector({
  keys,
  selectedKey,
  selectedModel,
  disabled,
  refreshing,
  onRefresh,
  onSelect,
}: {
  keys: PlaygroundKey[];
  selectedKey?: PlaygroundKey;
  selectedModel?: PlaygroundModel;
  disabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onSelect: (key: PlaygroundKey, model: PlaygroundModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftKeyId, setDraftKeyId] = useState('');
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const draftKey = keys.find((key) => key.id === draftKeyId);
  const models = draftKey?.models.filter((model) => model.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <Popover.Root
      open={open && !disabled}
      onOpenChange={({ open: nextOpen }) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setDraftKeyId(selectedKey?.id ?? keys[0]?.id ?? '');
          setSearch('');
        }
      }}
      positioning={{ placement: 'top-end', strategy: 'fixed', gutter: 12, shift: 12 }}
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
          minW="0"
          maxW={{ base: '160px', sm: '300px' }}
          disabled={disabled}
          aria-label={selectedModel ? `选择 API Key 和模型，当前模型 ${selectedModel.name}` : '选择 API Key 和模型'}
          title={selectedModel?.name ?? '选择 API Key 和模型'}
        >
          <Text truncate>{selectedModel?.name ?? '选择模型'}</Text>
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
                选择 Key 和模型
              </Popover.Title>
              <HStack gap="1">
                <IconButton
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label="刷新 Key 和模型"
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
                  API Key
                </Text>
                <Stack gap="1" overflowY="auto" minH="0" aria-label="API Key 列表">
                  {keys.map((key) => (
                    <Button
                      key={key.id}
                      type="button"
                      variant="ghost"
                      h="auto"
                      minH="48px"
                      px="2"
                      py="2"
                      flexShrink="0"
                      justifyContent="space-between"
                      borderRadius="lg"
                      bg={draftKey?.id === key.id ? 'gray.200' : 'transparent'}
                      aria-pressed={draftKey?.id === key.id}
                      onClick={() => {
                        setDraftKeyId(key.id);
                        setSearch('');
                      }}
                    >
                      <Box minW="0" textAlign="left">
                        <Text fontSize="sm" whiteSpace="normal" overflowWrap="anywhere">
                          {key.name}
                        </Text>
                        <Text
                          fontSize="xs"
                          color="gray.500"
                          fontWeight="400"
                          whiteSpace="normal"
                          overflowWrap="anywhere"
                        >
                          {key.channelName}
                        </Text>
                      </Box>
                      {draftKey?.id === key.id && <Check size={14} aria-hidden="true" style={{ flexShrink: 0 }} />}
                    </Button>
                  ))}
                  {!keys.length && (
                    <Text fontSize="xs" color="gray.500" px="2">
                      暂无可用 Key
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
                        selectedKey?.id === draftKey?.id && selectedModel?.id === model.id ? 'gray.100' : 'transparent'
                      }
                      aria-pressed={selectedKey?.id === draftKey?.id && selectedModel?.id === model.id}
                      onClick={() => {
                        if (!draftKey) return;
                        onSelect(draftKey, model);
                        setOpen(false);
                      }}
                    >
                      <Text fontSize="sm" fontWeight="500" whiteSpace="normal" overflowWrap="anywhere" textAlign="left">
                        {model.name}
                      </Text>
                      {selectedKey?.id === draftKey?.id && selectedModel?.id === model.id && (
                        <Check size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
                      )}
                    </Button>
                  ))}
                  {!models?.length && (
                    <Text fontSize="sm" color="gray.500" p="3">
                      {draftKey ? '没有匹配的模型' : '请选择 API Key'}
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
