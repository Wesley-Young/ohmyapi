import { useChat } from '@ai-sdk/react';
import { Box, Button, Flex, Heading, HStack, IconButton, Link, Stack, Text, Textarea } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { PlaygroundSelector } from '../components/playground-selector';
import { ErrorText, Loading, PrimaryButton } from '../components/ui';
import { formError } from '../lib/format';
import { messageText, playgroundTransport, preferredEndpoint } from '../lib/playground';
import { queryClient, trpc } from '../lib/trpc';

export default function Playground() {
  const options = useQuery(trpc.keys.playgroundOptions.queryOptions(undefined, { staleTime: 0, gcTime: 0 }));
  const [keyId, setKeyId] = useState('');
  const [modelId, setModelId] = useState('');
  const [input, setInput] = useState('');
  const scrollArea = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const followOutput = useRef(true);
  const selectedKey = options.data?.find((key) => key.id === keyId);
  const selectedModel = selectedKey?.models.find((model) => model.id === modelId);
  const endpoint = selectedKey && preferredEndpoint(selectedKey.endpoints);
  const transport = useMemo(
    () => playgroundTransport(selectedKey, selectedModel, endpoint),
    [selectedKey, selectedModel, endpoint],
  );
  const { messages, status, error, sendMessage, stop, regenerate, setMessages, clearError } = useChat({
    id: `${keyId}:${modelId}:${endpoint ?? ''}`,
    transport,
    throttle: 50,
    onFinish: () => {
      void queryClient.invalidateQueries(trpc.wallet.pathFilter());
      void queryClient.invalidateQueries(trpc.requests.pathFilter());
    },
  });
  const busy = status === 'submitted' || status === 'streaming';
  const ready = Boolean(selectedKey && selectedModel && endpoint && !options.error);

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
                  {ready ? '试一试「给我讲个程序员冷笑话」' : '请先选择 API Key 和模型'}
                </Text>
              </Flex>
            ) : (
              <Stack gap="8" w="full" maxW="800px" mx="auto" px={{ base: 1, md: 4 }} pt="4">
                {messages.map((message) => (
                  <Stack key={message.id} gap="2" align={message.role === 'user' ? 'end' : 'start'} minW="0">
                    {message.role !== 'user' && (
                      <Text fontSize="xs" color="gray.500" fontWeight="500" overflowWrap="anywhere">
                        {selectedModel?.name ?? 'AI'}
                      </Text>
                    )}
                    <Box
                      bg={message.role === 'user' ? 'gray.100' : 'white'}
                      px={message.role === 'user' ? 5 : 0}
                      py={message.role === 'user' ? 3 : 0}
                      borderRadius="2xl"
                      maxW={message.role === 'user' ? '85%' : 'full'}
                    >
                      <Text whiteSpace="pre-wrap" overflowWrap="anywhere" fontSize="sm" lineHeight="1.9">
                        {messageText(message) || (busy ? '等待回复…' : '未返回文字内容')}
                      </Text>
                    </Box>
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
          maxW="1080px"
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
                  暂无可用的 Key 和模型，请在{' '}
                  <Link asChild color="#635bff">
                    <RouterLink to="/console/keys">API Key</RouterLink>
                  </Link>{' '}
                  页面创建或绑定渠道。
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
              <Stack direction={{ base: 'column', xl: 'row' }} align={{ base: 'stretch', xl: 'end' }} gap="2">
                <Textarea
                  id="playground-input"
                  aria-label="消息"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="输入消息…"
                  disabled={!ready || busy}
                  rows={1}
                  flex={{ xl: '1' }}
                  minW="0"
                  minH="40px"
                  maxH="min(160px, 25dvh)"
                  resize="none"
                  autoresize
                  border="none"
                  px="1"
                  py="2"
                  borderRadius="md"
                  focusRingColor="#635bff"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                <HStack justify="end" gap="1" minW="0" flexShrink="0" pb={{ xl: '1' }}>
                  {messages.length > 0 && !busy && (
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      mr="auto"
                      color="gray.500"
                      aria-label="重试"
                      title="重试"
                      disabled={!ready}
                      onClick={() => {
                        followOutput.current = true;
                        void regenerate();
                      }}
                    >
                      <RotateCcw size={16} aria-hidden="true" />
                    </IconButton>
                  )}
                  <PlaygroundSelector
                    keys={options.data ?? []}
                    selectedKey={selectedKey}
                    selectedModel={selectedModel}
                    disabled={busy || options.isPending}
                    refreshing={options.isFetching}
                    onRefresh={() => void options.refetch()}
                    onSelect={(key, model) => {
                      if (key.id !== keyId || model.id !== modelId) {
                        setKeyId(key.id);
                        setModelId(model.id);
                        setInput('');
                        followOutput.current = true;
                      }
                    }}
                  />
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
                    <PrimaryButton
                      type="submit"
                      size="sm"
                      px="0"
                      minW="36px"
                      aria-label="发送消息"
                      title="发送消息"
                      disabled={!ready || !input.trim()}
                    >
                      <ArrowUp size={18} aria-hidden="true" />
                    </PrimaryButton>
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
