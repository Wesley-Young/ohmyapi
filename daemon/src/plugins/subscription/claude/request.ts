import { GatewayError } from '../../../core/errors.js';
import { claudeBetas } from './betas.js';
import { cacheControl, prepareCache } from './cache.js';
import type { ClaudeCredentials } from './credentials.js';
import { isFable, isLegacy, progressDisplay } from './models.js';
import type { ClaudeSession } from './session.js';
import { signBody } from './signing.js';
import { type Data, object, objects, remapTools } from './tools.js';

import { createHash, randomUUID } from 'node:crypto';

// 参考 CLIProxyAPI 54946fa3dfa29c6ca7312ac141a92cdd5e413771，CC 2.1.280。
// 请求构造顺序与 execute/stream 一致；仅支持非 CC 客户端的 Messages 入口。
export const claudeCodeVersion = '2.1.280';
const textBlock = (text: string): Data => ({ type: 'text', text });
const reminder = (text: string) => `<system-reminder>\n${text}${text.endsWith('\n') ? '' : '\n'}</system-reminder>`;
function invalid(message: string): never {
  throw new GatewayError(400, 'invalid_request', message);
}

export function validateClaudeRequest(body: Data) {
  if (!Array.isArray(body.messages) || !body.messages.length || objects(body.messages).length !== body.messages.length)
    invalid('messages must be a nonempty array');
  for (const message of objects(body.messages)) {
    if (!['user', 'assistant', 'system'].includes(String(message.role))) invalid('Unsupported message role');
    if (
      typeof message.content !== 'string' &&
      (!Array.isArray(message.content) || objects(message.content).length !== message.content.length)
    )
      invalid('Invalid message content');
    if (message.role === 'system' && isLegacy(String(body.model)))
      invalid('This model does not support mid-conversation system messages');
  }
  if (!objects(body.messages).some((m) => m.role === 'user')) invalid('A user message is required');
  if (
    body.system !== undefined &&
    typeof body.system !== 'string' &&
    (!Array.isArray(body.system) || objects(body.system).length !== body.system.length)
  )
    invalid('Invalid system prompt');
  for (const block of objects(body.system))
    if (block.type !== 'text' || typeof block.text !== 'string') invalid('System blocks must contain text');
  if (body.tools !== undefined && (!Array.isArray(body.tools) || objects(body.tools).length !== body.tools.length))
    invalid('Invalid tools');
  const thinking = object(body.thinking);
  const forced = ['any', 'tool'].includes(String(object(body.tool_choice)?.type));
  if (
    !forced &&
    thinking?.type === 'enabled' &&
    (!Number.isSafeInteger(thinking.budget_tokens) ||
      Number(thinking.budget_tokens) < 1024 ||
      Number(thinking.budget_tokens) >= Number(body.max_tokens))
  )
    invalid('thinking.budget_tokens must be at least 1024 and below max_tokens');
}

export async function prepareClaudeRequest(
  parsed: Data,
  request: Request,
  credentials: ClaudeCredentials,
  session: ClaudeSession,
  aliasSecret: string,
) {
  validateClaudeRequest(parsed);
  const body = structuredClone(parsed);
  const explicit = object(body.prompt_cache_options)?.mode === 'explicit';
  const messages = objects(body.messages);
  const first = messages.find((m) => m.role === 'user');
  if (!first) invalid('A user message is required');
  const original =
    typeof first.content === 'string'
      ? first.content
      : String(
          objects(first.content).find((b) => b.type === 'text' && !String(b.text).startsWith('<system-reminder>'))
            ?.text ?? '',
        );
  // JS 按 UTF-16 下标采样，与 CPA 的 surrogate 处理一致。
  const sampled = [4, 7, 20].map((i) => original[i] ?? '0').join('');
  const fingerprint = createHash('sha256')
    .update(`59cf53e54c78${sampled}${claudeCodeVersion}`)
    .digest('hex')
    .slice(0, 3);
  let billing = `x-anthropic-billing-header: cc_version=${claudeCodeVersion}.${fingerprint}; cc_entrypoint=cli; cch=00000;`;
  if (session.previousRequestId) billing += ` cc_prev_req=${session.previousRequestId};`;
  billing += ` cc_prompt_id=${session.promptId};`;
  if (session.human) billing += ' cc_turn_origin=human;';
  const forwarded = typeof body.system === 'string' ? [textBlock(body.system)] : objects(body.system);
  const identity = textBlock("You are Claude Code, Anthropic's official CLI for Claude.");
  if (!explicit) identity.cache_control = cacheControl();
  const system: Data[] = [textBlock(billing), identity];
  body.system = system;
  if (isFable(String(body.model)))
    system.push(
      textBlock(
        '# Reporting outcomes\n\nReport what actually happened, not what you intended. When you say something is done, sent, saved, fixed, or verified, that claim must rest on a result you observed in this session — tool output, the file as it now reads, the page as it now loads — not on what the step should have produced. If you did not check, say you did not check. If any step failed, was skipped, or came back different from what you expected, say so in the first sentence of your report, before anything else, even when the rest of the work succeeded. Never quietly work around a failure in a way that makes it look resolved; a problem the user can see is recoverable, one your summary hides is not. When you stop before the task is complete, your first line says so plainly and names what is left. Do not describe partial work as done, and do not let a summary read as more certain than the evidence behind it.',
      ),
    );
  const blocks: Data[] = forwarded
    .filter(
      (b) =>
        String(b.text).trim() &&
        !String(b.text).startsWith('x-anthropic-billing-header:') &&
        b.text !== "You are Claude Code, Anthropic's official CLI for Claude.",
    )
    .map((b) => ({ ...b, ...(!explicit ? { cache_control: cacheControl() } : {}) }));
  const advisor = messages.some((m) =>
    objects(m.content).some(
      (b) =>
        ['advisor_tool_result', 'advisor_redacted_result'].includes(String(b.type)) ||
        (b.type === 'server_tool_use' && b.name === 'advisor'),
    ),
  );
  if (advisor) system.push(...blocks);
  else if (isLegacy(String(body.model))) {
    if (typeof first.content === 'string') first.content = [textBlock(first.content)];
    const content = objects(first.content);
    let at = 0;
    while (content[at]?.type === 'tool_result') at++;
    content.splice(
      at,
      0,
      ...blocks.map((b) => {
        const next: Data = textBlock(reminder(String(b.text)));
        if (explicit && b.cache_control) next.cache_control = b.cache_control;
        return next;
      }),
    );
    first.content = content;
  } else if (blocks.length) {
    let at = messages.indexOf(first) + 1;
    while (messages[at]?.role === 'user') at++;
    const already = blocks.every(
      (b, i) =>
        messages[at + i]?.role === 'system' &&
        objects(messages[at + i].content)
          .map((c) => c.text)
          .join('') === b.text,
    );
    if (!already) messages.splice(at, 0, ...blocks.map((b) => ({ role: 'system', content: [b] })));
  }
  if (typeof first.content === 'string') first.content = [textBlock(first.content)];
  const content = objects(first.content).filter(
    (b) => !(b.type === 'text' && String(b.text).startsWith('<system-reminder>\nAs you answer the user')),
  );
  if (!explicit) {
    const actual = content.find((b) => b.type === 'text' && !String(b.text).startsWith('<system-reminder>'));
    if (actual) actual.cache_control = cacheControl();
  }
  let at = 0;
  while (content[at]?.type === 'tool_result') at++;
  content.splice(
    at,
    0,
    textBlock(
      `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is ${session.date}.\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n\n`,
    ),
  );
  first.content = content;
  body.messages = messages;
  // 对齐 CPA 的非原生客户端规则：强制工具调用关闭 thinking，清理采样参数。
  if (['any', 'tool'].includes(String(object(body.tool_choice)?.type))) {
    delete body.thinking;
    const output = object(body.output_config);
    if (output) {
      delete output.effort;
      if (!Object.keys(output).length) delete body.output_config;
    }
  }
  delete body.temperature;
  delete body.top_p;
  const thinking = object(body.thinking);
  if (thinking && ['enabled', 'adaptive', 'auto'].includes(String(thinking.type))) delete body.top_k;
  if (thinking && ['enabled', 'adaptive'].includes(String(thinking.type))) {
    if (progressDisplay(String(body.model)) && thinking.display === undefined) thinking.display = 'updates';
    // 上游不允许 compaction 与 context_management 同时出现；thinking 照常保留给摘要调用。
    if (body.compaction === undefined)
      body.context_management ??= { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] };
  }
  body.diagnostics = { previous_message_id: session.previousMessageId ?? null };
  prepareCache(body, explicit);
  delete body.prompt_cache_options;
  const reverse = remapTools(body, aliasSecret);
  body.metadata = {
    ...object(body.metadata),
    user_id: JSON.stringify({
      device_id: credentials.deviceId,
      account_uuid: credentials.accountId,
      session_id: session.id,
    }),
  };
  delete (body.metadata as Data).session_id;
  const requested = [
    ...(request.headers.get('anthropic-beta') ?? '').split(','),
    ...(Array.isArray(body.betas) ? body.betas.map(String) : []),
  ]
    .map((v) => v.trim())
    .filter(Boolean);
  delete body.betas;
  body.stream = parsed.stream === true;
  const beta = claudeBetas(body, requested);
  const headers = new Headers({
    authorization: `Bearer ${credentials.accessToken}`,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': beta,
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
    'user-agent': `claude-cli/${claudeCodeVersion} (external, cli)`,
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-lang': 'js',
    'x-stainless-timeout': '600',
    'x-stainless-package-version': '0.112.1',
    'x-stainless-runtime-version': 'v26.3.0',
    'x-stainless-os': 'MacOS',
    'x-stainless-arch': 'arm64',
    'x-claude-code-session-id': session.id,
    'x-client-request-id': randomUUID(),
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate, br, zstd',
    connection: 'keep-alive',
  });
  return { body: await signBody(body), billingBody: body, headers, reverse };
}
