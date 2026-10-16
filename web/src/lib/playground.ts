import { Chat } from '@ai-sdk/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { type ChatTransport, streamText, toUIMessageStream, type UIMessage } from 'ai';

import { queryClient, trpc } from './trpc';

export type PlaygroundKey = RouterOutputs['keys']['playgroundOptions'][number];
export type PlaygroundModel = PlaygroundKey['models'][number];
export type PlaygroundEndpoint = PlaygroundKey['endpoints'][number];
/** 回复消息记录生成它的模型，换模型后历史消息仍显示原模型。 */
export type PlaygroundMessage = UIMessage<{ model?: string }>;
/** 发送消息时使用的 Key、模型和协议，由页面在选择变化后更新。 */
export type PlaygroundSelection = { key?: PlaygroundKey; model?: PlaygroundModel; endpoint?: PlaygroundEndpoint };
/** 保存在 localStorage 的选择，只含 ID，不含 Key 的令牌。 */
export type StoredPlaygroundSelection = { keyId?: string; modelId?: string; endpoint?: PlaygroundEndpoint };

const endpointOrder: PlaygroundEndpoint[] = [
  '/v1/responses',
  '/v1/messages',
  '/v1/chat/completions',
  '/v1beta/generateContent',
];

/** Key 可在 Playground 中对话的端点，按推荐顺序排列。 */
export function playgroundEndpoints(endpoints: PlaygroundEndpoint[]) {
  return endpointOrder.filter((endpoint) => endpoints.includes(endpoint));
}

/** 与网关的 Gemini 路径规则一致：名称只含字母、数字、下划线、连字符和点。 */
const geminiModelName = /^(?!\.+$)[A-Za-z0-9_.-]{1,128}$/;

export function messageText(message: PlaygroundMessage) {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

function playgroundTransport(selection: PlaygroundSelection): ChatTransport<PlaygroundMessage> {
  return {
    async sendMessages({ messages, abortSignal }) {
      const { key, model: selectedModel, endpoint } = selection;
      if (!key || !selectedModel || !endpoint) throw new Error('请选择可用的 API Key 和模型');
      if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now())
        throw new Error('API Key 已过期，请选择其他 Key');

      if (endpoint === '/v1beta/generateContent' && !geminiModelName.test(selectedModel.name))
        throw new Error('该模型名称无法通过 Gemini 端点调用，请切换协议');

      const settings = { baseURL: `${window.location.origin}/v1`, apiKey: key.token };
      const model =
        endpoint === '/v1/responses'
          ? (await import('@ai-sdk/openai')).createOpenAI(settings).responses(selectedModel.name)
          : endpoint === '/v1/messages'
            ? (await import('@ai-sdk/anthropic')).createAnthropic(settings).messages(selectedModel.name)
            : endpoint === '/v1beta/generateContent'
              ? (await import('@ai-sdk/google'))
                  .createGoogleGenerativeAI({ baseURL: `${window.location.origin}/v1beta`, apiKey: key.token })
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
        messageMetadata: ({ part }) => (part.type === 'start' ? { model: selectedModel.name } : undefined),
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

/** 读取用户上次的 Key、模型和协议选择；存储不可用或内容无效时返回空选择。 */
export function loadPlaygroundSelection(userId: string): StoredPlaygroundSelection {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(selectionStorageKey(userId)) ?? 'null');
    if (!value || typeof value !== 'object') return {};
    const stored = value as Record<string, unknown>;
    const endpoint = endpointOrder.find((item) => item === stored.endpoint);
    return { keyId: optionalString(stored.keyId), modelId: optionalString(stored.modelId), endpoint };
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
