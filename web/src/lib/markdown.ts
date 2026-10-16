/**
 * 代码块、行内代码、`\[..\]` 和 `\(..\)`。代码原样保留，只转换代码之外的公式。
 * 分组：1 代码块（2 围栏字符）、3 行内代码的反引号、4 块级公式、5 行内公式。
 */
const pattern =
  /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[`~]*[ \t]*$|(?![\s\S])))|(`+)[\s\S]*?\3|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/gm;

/**
 * 把 `\(..\)` 和 `\[..\]` 转换为 remark-math 识别的 `$..$` 和 `$$..$$`。
 * 块级公式独占几行，并沿用所在行的缩进，在列表等容器中保持结构。
 */
export function normalizeMath(source: string): string {
  return source.replace(
    pattern,
    (
      match: string,
      fence: string | undefined,
      _fenceMarker: string | undefined,
      ticks: string | undefined,
      display: string | undefined,
      inline: string | undefined,
      offset: number,
    ) => {
      if (fence !== undefined || ticks !== undefined) return match;
      if (inline !== undefined) return `$${inline}$`;
      const body = (display ?? '').trim();
      if (!body) return match;
      const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
      const before = source.slice(lineStart, offset);
      const indent = /^[ \t]*/.exec(before)?.[0] ?? '';
      const end = offset + match.length;
      const nextBreak = source.indexOf('\n', end);
      const after = source.slice(end, nextBreak === -1 ? undefined : nextBreak);
      const lines = body.split('\n').map((line) => `${indent}${line.trim()}`);
      const block = [`$$`, ...lines, `${indent}$$`].join('\n');
      return `${before.trim() ? `\n${indent}` : ''}${block}${after.trim() ? `\n${indent}` : ''}`;
    },
  );
}
