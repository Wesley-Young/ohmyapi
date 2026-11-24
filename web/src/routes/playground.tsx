import { useChat } from '@ai-sdk/react';
import { Box, Button, Flex, Heading, HStack, Stack, Text, Textarea } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { IconButton } from '../components/icon-button';
import { Markdown } from '../components/markdown';
import { PlaygroundProtocol } from '../components/playground-protocol';
import { PlaygroundSelector } from '../components/playground-selector';
import { ErrorText, Loading } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formatCount, formError } from '../lib/format';
import {
  loadPlaygroundSelection,
  messageText,
  type PlaygroundEndpoint,
  playgroundSession,
  savePlaygroundSelection,
} from '../lib/playground';
import { brandColor, brandHoverColor } from '../lib/theme';
import { trpc } from '../lib/trpc';

const usageFields = [
  ['input', 'I'],
  ['output', 'O'],
  ['cacheRead', 'CR'],
  ['cacheWrite', 'CW'],
] as const;

export default function Playground() {
  const options = useQuery(trpc.playground.options.queryOptions(undefined, { staleTime: 0, gcTime: 0 }));
  // 路由守卫保证已登录，切换账号时页面会重新挂载。
  const userId = useAuth().data?.id ?? '';
  const [stored] = useState(() => loadPlaygroundSelection(userId));
  const [channelId, setChannelId] = useState(stored.channelId ?? '');
  const [modelId, setModelId] = useState(stored.modelId ?? '');
  const [endpointChoice, setEndpointChoice] = useState(stored.endpoint);
  const [input, setInput] = useState('');
  const scrollArea = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const followOutput = useRef(true);
  const selectedChannel = options.data?.find((channel) => channel.id === channelId);
  const selectedModel = selectedChannel?.models.find((model) => model.id === modelId);
  const endpoints = selectedModel?.endpoints ?? [];
  // 选择的协议不再可用时（如切换了渠道或模型）回到推荐协议。
  const endpoint = endpoints.find((item) => item === endpointChoice) ?? endpoints[0];
  // 会话保存在内存中，与选择无关：切换渠道、模型或协议后继续当前对话。
  const session = playgroundSession(userId);
  const { messages, status, error, sendMessage, stop, regenerate, setMessages, clearError } = useChat({
    chat: session.chat,
    throttle: 50,
  });
  const busy = status === 'submitted' || status === 'streaming';
  const ready = Boolean(selectedChannel && selectedModel && endpoint && !options.error);

  useLayoutEffect(() => {
    Object.assign(session.selection, { channel: selectedChannel, model: selectedModel, endpoint });
  }, [session, selectedChannel, selectedModel, endpoint]);

  const select = (next: { channelId: string; modelId: string; endpoint?: PlaygroundEndpoint }) => {
    setChannelId(next.channelId);
    setModelId(next.modelId);
    setEndpointChoice(next.endpoint);
    savePlaygroundSelection(userId, next);
    if (status === 'error') clearError();
    followOutput.current = true;
  };

  useLayoutEffect(() => {
    const element = composer.current;
    if (!element) return;
    const measure = () => setComposerHeight(Math.ceil(element.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (messages.length && composerHeight && followOutput.current && scrollArea.current)
      scrollArea.current.scrollTop = scrollArea.current.scrollHeight;
  }, [messages, composerHeight]);

  const send = () => {
    const text = input.trim();
    if (!text || !ready || busy) return;
    followOutput.current = true;
    setInput('');
    void sendMessage({ text });
  };

  return (
    <Flex direction="column" h="full" minH="0">
      <HStack justify="space-between" gap="3" flexShrink="0" px={{ base: 4, md: 8 }} py="4">
        <Heading as="h1" fontSize="xl" fontWeight="600" letterSpacing="-0.03em">
          Playground
        </Heading>
        <Button
          size="sm"
          variant="ghost"
          color="gray.500"
          disabled={busy || !messages.length}
          onClick={() => {
            setMessages([]);
            clearError();
            setInput('');
            followOutput.current = true;
          }}
        >
          <Trash2 size={16} aria-hidden="true" />
          清空对话
        </Button>
      </HStack>
      <Box position="relative" flex="1" minH="0" isolation="isolate">
        <Box
          ref={scrollArea}
          position="absolute"
          inset="0"
          overflowY="auto"
          overscrollBehavior="contain"
          scrollPaddingBottom={`${composerHeight + 24}px`}
          role="log"
          aria-label="对话消息"
          aria-live="polite"
          onScroll={(event) => {
            const area = event.currentTarget;
            followOutput.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
          }}
        >
          <Flex direction="column" minH="full" px={{ base: 4, md: 8 }} pb={`${composerHeight + 24}px`}>
            {options.isPending ? (
              <Loading />
            ) : !messages.length ? (
              <Flex
                flex="1"
                direction="column"
                align="center"
                justify="center"
                gap="3"
                px="4"
                py="8"
                textAlign="center"
              >
                <Text color="gray.500" fontSize="sm">
                  {ready ? '试一试「给我讲个程序员冷笑话」' : '请先选择渠道和模型'}
                </Text>
              </Flex>
            ) : (
              <Stack gap="8" w="full" maxW="800px" mx="auto" px={{ base: 1, md: 4 }} pt="4">
                {messages.map((message, index) => (
                  <Stack key={message.id} gap="2" align={message.role === 'user' ? 'end' : 'start'} minW="0">
                    {message.role !== 'user' && (
                      <Text fontSize="xs" color="gray.500" fontWeight="500" overflowWrap="anywhere">
                        {message.metadata?.model ?? 'AI'}
                      </Text>
                    )}
                    <Box
                      bg={message.role === 'user' ? 'gray.100' : 'white'}
                      px={message.role === 'user' ? 5 : 0}
                      py={message.role === 'user' ? 3 : 0}
                      borderRadius="2xl"
                      maxW={message.role === 'user' ? '85%' : 'full'}
                    >
                      {message.role === 'user' ? (
                        <Text whiteSpace="pre-wrap" overflowWrap="anywhere" fontSize="sm" lineHeight="1.9">
                          {messageText(message)}
                        </Text>
                      ) : messageText(message) ? (
                        <Markdown content={messageText(message)} streaming={busy && index === messages.length - 1} />
                      ) : (
                        <Text color="gray.500" fontSize="sm" lineHeight="1.9">
                          {busy ? '等待回复…' : '未返回文字内容'}
                        </Text>
                      )}
                    </Box>
                    {(message.metadata?.usage || (index === messages.length - 1 && !busy)) && (
                      <HStack maxW="full" gap="2">
                        {message.metadata?.usage && (
                          <Flex
                            as="dl"
                            aria-label="Token 用量"
                            wrap="wrap"
                            columnGap="3"
                            rowGap="1"
                            fontSize="xs"
                            color="gray.500"
                          >
                            {usageFields.map(([field, label]) => {
                              const count = message.metadata?.usage?.[field];
                              return (
                                <HStack key={field} gap="1">
                                  <Box as="dt">{label}</Box>
                                  <Box as="dd" fontVariantNumeric="tabular-nums">
                                    {count == null ? '—' : formatCount(count)}
                                  </Box>
                                </HStack>
                              );
                            })}
                          </Flex>
                        )}
                        {index === messages.length - 1 && !busy && (
                          <IconButton
                            variant="ghost"
                            size="xs"
                            color="gray.500"
                            aria-label="重试"
                            disabled={!ready}
                            onClick={() => {
                              followOutput.current = true;
                              void regenerate();
                            }}
                          >
                            <RotateCcw size={14} aria-hidden="true" />
                          </IconButton>
                        )}
                      </HStack>
                    )}
                  </Stack>
                ))}
                {busy && (
                  <Text role="status" color="gray.500" fontSize="xs">
                    {status === 'submitted' ? '正在连接…' : '正在生成…'}
                  </Text>
                )}
              </Stack>
            )}
          </Flex>
        </Box>
        <Stack
          ref={composer}
          gap="3"
          w="full"
          maxW="880px"
          mx="auto"
          position="absolute"
          bottom="0"
          insetX="0"
          zIndex="1"
          pointerEvents="none"
          px={{ base: 3, md: 5 }}
          pb="max(12px, env(safe-area-inset-bottom, 0px))"
          maxH="100%"
          overflowY="auto"
        >
          {(options.error || error || (!options.isPending && !options.data?.length)) && (
            <Box overflowWrap="anywhere" bg="white" borderRadius="lg" p="3" pointerEvents="auto">
              <ErrorText>{formError(options.error)?.message ?? error?.message}</ErrorText>
              {!options.isPending && !options.error && !options.data?.length && (
                <Text fontSize="sm" color="gray.500">
                  当前账号暂无可用的对话模型，请联系管理员开通渠道。
                </Text>
              )}
            </Box>
          )}
          <Box
            bg="white"
            pointerEvents="auto"
            flexShrink="0"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="24px"
            boxShadow="0 4px 24px rgba(0, 0, 0, 0.06)"
            p={{ base: 3, md: 4 }}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <Stack gap="2">
                <Textarea
                  id="playground-input"
                  aria-label="消息"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="输入消息…"
                  disabled={!ready || busy}
                  rows={1}
                  minW="0"
                  minH="40px"
                  maxH="min(160px, 25dvh)"
                  resize="none"
                  autoresize
                  border="none"
                  px="1"
                  py="2"
                  borderRadius="md"
                  focusRingColor={brandColor}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                <HStack gap="1" minW="0">
                  <PlaygroundSelector
                    channels={options.data ?? []}
                    selectedChannel={selectedChannel}
                    selectedModel={selectedModel}
                    disabled={busy || options.isPending}
                    refreshing={options.isFetching}
                    onRefresh={() => void options.refetch()}
                    onSelect={(channel, model) => {
                      if (channel.id !== channelId || model.id !== modelId)
                        select({ channelId: channel.id, modelId: model.id, endpoint });
                    }}
                  />
                  {endpoint && endpoints.length > 1 && (
                    <PlaygroundProtocol
                      endpoints={endpoints}
                      value={endpoint}
                      disabled={busy || options.isPending}
                      onChange={(next) => {
                        if (next !== endpoint) select({ channelId, modelId, endpoint: next });
                      }}
                    />
                  )}

                  <Box flex="1" />
                  {busy ? (
                    <IconButton
                      type="button"
                      variant="outline"
                      size="sm"
                      borderRadius="full"
                      aria-label="停止生成"
                      title="停止生成"
                      onClick={() => void stop()}
                    >
                      <Square size={14} aria-hidden="true" />
                    </IconButton>
                  ) : (
                    <IconButton
                      type="submit"
                      bg={brandColor}
                      color="white"
                      borderRadius="full"
                      _hover={{ bg: brandHoverColor }}
                      size="sm"
                      px="0"
                      minW="36px"
                      aria-label="发送消息"
                      title="发送消息"
                      disabled={!ready || !input.trim()}
                    >
                      <ArrowUp size={18} aria-hidden="true" />
                    </IconButton>
                  )}
                </HStack>
              </Stack>
            </form>
          </Box>
          <Text
            fontSize="xs"
            color="gray.500"
            textAlign="center"
            px="2"
            bg="white"
            borderRadius="md"
            alignSelf="center"
            pointerEvents="auto"
          >
            Enter 发送，Shift + Enter 换行
          </Text>
        </Stack>
      </Box>
    </Flex>
  );
}
