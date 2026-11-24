import { Chat } from '@ai-sdk/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { type ChatTransport, streamText, toUIMessageStream, type UIMessage } from 'ai';

import { queryClient, trpc } from './trpc';

export type PlaygroundChannel = RouterOutputs['playground']['options'][number];
export type PlaygroundModel = PlaygroundChannel['models'][number];
export type PlaygroundEndpoint = PlaygroundModel['endpoints'][number];
/** 每条回复保留本轮使用的模型及 SDK 在完成时返回的 Token 用量。 */
export type PlaygroundMessage = UIMessage<{
  model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}>;
/** 发送消息时使用的渠道、模型和协议，由页面在选择变化后更新。 */
export type PlaygroundSelection = {
  channel?: PlaygroundChannel;
  model?: PlaygroundModel;
  endpoint?: PlaygroundEndpoint;
};
/** 保存在 localStorage 的选择，只保存 ID 和协议。 */
export type StoredPlaygroundSelection = { channelId?: string; modelId?: string; endpoint?: string };

export function messageText(message: PlaygroundMessage) {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

const playgroundFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  for (const name of ['authorization', 'x-api-key', 'x-goog-api-key']) headers.delete(name);
  headers.set('X-Ohmyapi-Request', '1');
  const response = await fetch(input, { ...init, headers, credentials: 'same-origin' });
  if (response.status === 401) void queryClient.invalidateQueries(trpc.auth.me.queryFilter());
  return response;
};

function playgroundTransport(selection: PlaygroundSelection): ChatTransport<PlaygroundMessage> {
  return {
    async sendMessages({ messages, abortSignal }) {
      const { channel, model: selectedModel, endpoint } = selection;
      if (!channel || !selectedModel || !endpoint) throw new Error('请选择可用的渠道和模型');
      const base = `${window.location.origin}/api/playground/${channel.id}`;
      // SDK 要求填写凭据；走控制台入口时只发送登录 Cookie 和同源校验头。
      const settings = { baseURL: `${base}/v1`, apiKey: 'playground', fetch: playgroundFetch };
      const model =
        endpoint === '/v1/responses'
          ? (await import('@ai-sdk/openai')).createOpenAI(settings).responses(selectedModel.name)
          : endpoint === '/v1/messages'
            ? (await import('@ai-sdk/anthropic')).createAnthropic(settings).messages(selectedModel.name)
            : endpoint === '/v1beta/generateContent'
              ? (await import('@ai-sdk/google'))
                  .createGoogleGenerativeAI({ ...settings, baseURL: `${base}/v1beta` })
                  .chat(selectedModel.name)
              : (await import('@ai-sdk/openai-compatible'))
                  .createOpenAICompatible({ ...settings, name: 'ohmyapi', includeUsage: true })
                  .chatModel(selectedModel.name);

      const result = streamText({
        model,
        // 每轮发送完整文字历史，避免引用供应商保存的消息或推理状态。
        messages: messages
          .map((message) => ({ role: message.role, content: messageText(message) }))
          .filter((message) => message.content.trim().length > 0),
        abortSignal,
        maxRetries: 0,
        // Messages 要求输出上限；其余协议保留上游缺省行为。
        maxOutputTokens: endpoint === '/v1/messages' ? Math.min(4096, selectedModel.outputTokenLimit) : undefined,
        providerOptions: endpoint === '/v1/responses' ? { openai: { store: false } } : undefined,
        onError: () => {},
      });
      return toUIMessageStream({
        stream: result.stream,
        originalMessages: messages,
        messageMetadata: ({ part }) => {
          if (part.type === 'start') return { model: selectedModel.name };
          if (part.type === 'finish' && part.finishReason !== 'error') {
            const { inputTokens, outputTokens, inputTokenDetails } = part.totalUsage;
            return {
              usage: {
                input: inputTokens,
                output: outputTokens,
                cacheRead: inputTokenDetails.cacheReadTokens,
                cacheWrite: inputTokenDetails.cacheWriteTokens,
              },
            };
          }
        },
        sendReasoning: false,
        sendSources: false,
        onError: (error) => (error instanceof Error ? error.message : '请求失败，请重试'),
      });
    },
    async reconnectToStream() {
      return null;
    },
  };
}

let session: { userId: string; chat: Chat<PlaygroundMessage>; selection: PlaygroundSelection } | undefined;

/** 当前用户的 Playground 会话。只保存在内存中：切换页面后保留，刷新或切换账号后丢弃。 */
export function playgroundSession(userId: string) {
  if (session?.userId !== userId) {
    void session?.chat.stop();
    const selection: PlaygroundSelection = {};
    session = {
      userId,
      selection,
      chat: new Chat<PlaygroundMessage>({
        transport: playgroundTransport(selection),
        onFinish: () => {
          void queryClient.invalidateQueries(trpc.wallet.pathFilter());
          void queryClient.invalidateQueries(trpc.requests.pathFilter());
        },
      }),
    };
  }
  return session;
}

const selectionStorageKey = (userId: string) => `ohmyapi:playground:${userId}`;
const optionalString = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** 读取用户上次的渠道、模型和协议选择；存储不可用或内容无效时返回空选择。 */
export function loadPlaygroundSelection(userId: string): StoredPlaygroundSelection {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(selectionStorageKey(userId)) ?? 'null');
    if (!value || typeof value !== 'object') return {};
    const stored = value as Record<string, unknown>;
    return {
      channelId: optionalString(stored.channelId),
      modelId: optionalString(stored.modelId),
      endpoint: optionalString(stored.endpoint),
    };
  } catch {
    return {};
  }
}

export function savePlaygroundSelection(userId: string, selection: StoredPlaygroundSelection) {
  try {
    localStorage.setItem(selectionStorageKey(userId), JSON.stringify(selection));
  } catch {
    // 存储不可用时只影响下次打开的默认选择。
  }
}
