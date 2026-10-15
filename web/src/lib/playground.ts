import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { type ChatTransport, streamText, toUIMessageStream, type UIMessage } from 'ai';

export type PlaygroundKey = RouterOutputs['keys']['playgroundOptions'][number];
export type PlaygroundModel = PlaygroundKey['models'][number];
export type PlaygroundEndpoint = PlaygroundKey['endpoints'][number];

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

export function messageText(message: UIMessage) {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

export function playgroundTransport(
  key: PlaygroundKey | undefined,
  selectedModel: PlaygroundModel | undefined,
  endpoint: PlaygroundEndpoint | undefined,
): ChatTransport<UIMessage> {
  return {
    async sendMessages({ messages, abortSignal }) {
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
