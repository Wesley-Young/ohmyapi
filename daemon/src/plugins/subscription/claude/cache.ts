import { type Data, object, objects } from './tools.ts';

export const cacheControl = () => ({ type: 'ephemeral' });
export function prepareCache(body: Data, explicit: boolean) {
  const tools = objects(body.tools);
  const system = objects(body.system);
  const messages = objects(body.messages);
  if (!explicit) {
    if (!system.some((b) => b.cache_control) && system.length) system[system.length - 1].cache_control = cacheControl();
    const last = messages.findLast(
      (m) =>
        ['user', 'assistant'].includes(String(m.role)) &&
        (typeof m.content === 'string' ||
          (objects(m.content).length > 0 &&
            (m.role !== 'assistant' ||
              !['thinking', 'redacted_thinking'].includes(String(objects(m.content).at(-1)?.type))))),
    );
    const final = messages.at(-1);
    const target =
      last && final?.role === 'system' && typeof final.content === 'string' && final.content.trim() ? final : last;
    if (target) {
      if (typeof target.content === 'string') target.content = [{ type: 'text', text: target.content }];
      const blocks = objects(target.content);
      if (!blocks.some((b) => b.cache_control) && blocks.length)
        blocks[blocks.length - 1].cache_control = cacheControl();
    }
  }
  const messageBlocks = messages.flatMap((m) => objects(m.content));
  const cached = (blocks: Data[]) => blocks.filter((b) => b.cache_control !== undefined);
  const sys = cached(system),
    tool = cached(tools),
    msg = cached(messageBlocks);
  let excess = sys.length + tool.length + msg.length - (body.thread != null ? 3 : 4);
  for (const block of [...sys.slice(0, -1), ...tool.slice(0, -1), ...msg, ...sys.slice(-1), ...tool.slice(-1)]) {
    if (excess-- <= 0) break;
    delete block.cache_control;
  }
  let seen5m = false;
  for (const block of [...tools, ...system, ...messageBlocks]) {
    const control = object(block.cache_control);
    if (!control || explicit) continue;
    if (!control.ttl)
      block.cache_control = {
        type: control.type,
        ttl: '1h',
        ...(control.scope !== undefined ? { scope: control.scope } : {}),
      };
    const current = object(block.cache_control);
    if (!current) continue;
    if (current.ttl !== '1h') seen5m = true;
    else if (seen5m) delete current.ttl;
  }
}
