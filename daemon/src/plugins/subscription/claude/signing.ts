import { xxhash64 } from 'hash-wasm';

// 移植 CPA 54946fa3 / claude_signing.go；授权见 LICENSE.CLIProxyAPI。
// 直接扫描最终 JSON，保留空白、转义和字段顺序，不能用 parse/stringify 构造哈希视图。
export function normalizeCCH(body: string) {
  let pos = 0;
  const edits: { start: number; end: number }[] = [];
  const edit = (start: number, end: number) => {
    if (start < end) edits.push({ start, end });
  };
  const whitespace = () => {
    while (/\s/.test(body[pos] ?? '') && pos < body.length) pos++;
  };
  const string = () => {
    const start = pos++;
    while (pos < body.length) {
      if (body[pos] === '\\') pos += 2;
      else if (body[pos++] === '"') return { start, end: pos };
    }
    throw new Error('Invalid CCH JSON string');
  };
  const value = (collect: boolean): void => {
    whitespace();
    if (body[pos] === '"') {
      string();
      return;
    }
    if (body[pos] === '[') {
      pos++;
      whitespace();
      while (body[pos] !== ']') {
        value(collect);
        whitespace();
        if (body[pos] !== ',') break;
        pos++;
      }
      pos++;
      return;
    }
    if (body[pos] !== '{') {
      while (pos < body.length && !/[\s,}\]]/.test(body[pos])) pos++;
      return;
    }
    pos++;
    whitespace();
    const members: { start: number; end: number; before: number; after: number; excluded: boolean }[] = [];
    let before = -1;
    while (body[pos] !== '}') {
      whitespace();
      const start = pos;
      const key = string();
      const rawKey = body.slice(key.start, key.end);
      whitespace();
      pos++;
      whitespace();
      const excluded = collect && ['"max_tokens"', '"fallbacks"', '"fallback_credit_token"'].includes(rawKey);
      if (collect && rawKey === '"model"' && body[pos] === '"') {
        const model = string();
        edit(model.start + 1, model.end - 1);
      } else value(collect && !excluded);
      const end = pos;
      whitespace();
      const after = body[pos] === ',' ? pos++ : -1;
      members.push({ start, end, before, after, excluded });
      if (after < 0) break;
      before = after;
    }
    pos++;
    if (!collect) return;
    for (let start = 0; start < members.length; start++) {
      if (!members[start].excluded) continue;
      let end = start;
      while (members[end + 1]?.excluded) end++;
      if (end + 1 < members.length) edit(members[start].start, members[end].after + 1);
      // CPA 保留这个原生行为：末尾连续多个排除字段时，哈希视图保留前一个逗号。
      else if (start > 0 && end === start) edit(members[start].before, members[end].end);
      else edit(members[start].start, members[end].end);
      start = end;
    }
  };
  value(true);
  edits.sort((a, b) => a.start - b.start);
  let last = 0;
  const parts: string[] = [];
  for (const item of edits) {
    parts.push(body.slice(last, item.start));
    last = item.end;
  }
  parts.push(body.slice(last));
  return parts.join('');
}

export async function signBody(body: Record<string, unknown>) {
  const serialized = JSON.stringify(body);
  // 只替换 system[0] 的占位符，用户消息中的同名文本保持不变。
  const system = body.system as { text: string }[];
  const billing = JSON.stringify(system[0].text);
  const marker = '"system":[{"type":"text","text":';
  const start = serialized.indexOf(marker + billing) + marker.length + billing.indexOf('cch=00000;') + 4;
  if (!serialized.includes(marker + billing) || !billing.includes('cch=00000;'))
    throw new Error('Missing Claude CCH placeholder');
  const hash = await xxhash64(normalizeCCH(serialized), 0xe32a3268, 0x4d659218);
  return Buffer.from(serialized.slice(0, start) + hash.slice(-5) + serialized.slice(start + 5));
}
