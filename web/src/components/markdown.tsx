// 样式须与 rehype-katex 使用的 katex 版本一致，不同版本的类名不同（如 0.19 把 `sizing` 改为 `katex-sizing`）。
import 'katex/dist/katex.min.css';

import { Box, Link } from '@chakra-ui/react';
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex, { type Options as KatexOptions } from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remend from 'remend';

import { normalizeMath } from '../lib/markdown';
import { brandColor, textColor } from '../lib/theme';

const remarkPlugins = [remarkGfm, remarkMath];
// rehype-katex 把写错的公式显示为红色原文，不中断渲染；这里只关闭严格模式的警告。
const katexOptions: KatexOptions = { strict: 'ignore' };
const rehypePlugins = [[rehypeKatex, katexOptions] as [typeof rehypeKatex, KatexOptions]];

const components: Components = {
  a: ({ node: _node, href, children }) => (
    <Link href={href} target="_blank" rel="noopener noreferrer" color={brandColor} textDecoration="underline">
      {children}
    </Link>
  ),
  // 不加载模型输出中的外部图片，显示为链接。
  img: ({ node: _node, src, alt }) =>
    typeof src === 'string' && src ? (
      <Link href={src} target="_blank" rel="noopener noreferrer" color={brandColor} textDecoration="underline">
        {alt || src}
      </Link>
    ) : (
      alt
    ),
  // 宽表格在容器内横向滚动。
  table: ({ node: _node, children }) => (
    <Box overflowX="auto" my="3">
      <table>{children}</table>
    </Box>
  ),
};

/** 渲染模型回复的 Markdown，支持 GFM 和 `$..$`、`$$..$$`、`\(..\)`、`\[..\]` 公式。 */
export const Markdown = memo(function Markdown({ content, streaming }: { content: string; streaming?: boolean }) {
  const normalized = normalizeMath(content);
  // 生成过程中补全未闭合的语法，避免内容闪烁。
  const source = streaming ? remend(normalized, { images: false, linkMode: 'text-only' }) : normalized;
  return (
    <Box
      fontSize="sm"
      lineHeight="1.9"
      color={textColor}
      overflowWrap="anywhere"
      minW="0"
      css={{
        '& > :first-child': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& p, & ul, & ol, & blockquote, & pre, & .katex-display': { my: 3 },
        '& h1, & h2, & h3, & h4, & h5, & h6': { fontWeight: 600, lineHeight: 1.4, mt: 6, mb: 2 },
        '& h1': { fontSize: 'xl' },
        '& h2': { fontSize: 'lg' },
        '& h3': { fontSize: 'md' },
        '& h4, & h5, & h6': { fontSize: 'sm' },
        '& ul, & ol': { ps: 6 },
        '& ul': { listStyleType: 'disc' },
        '& ol': { listStyleType: 'decimal' },
        '& li': { my: 1 },
        '& li > ul, & li > ol, & li > p': { my: 1 },
        '& li:has(> input[type=checkbox])': { listStyleType: 'none', ms: -5 },
        '& li > input[type=checkbox]': { me: 2, verticalAlign: 'middle' },
        '& strong': { fontWeight: 600 },
        '& blockquote': { borderStartWidth: '3px', borderColor: 'gray.200', ps: 4, color: 'gray.600' },
        '& hr': { my: 6, borderColor: 'gray.200' },
        '& code': {
          fontFamily: 'mono',
          fontSize: '0.875em',
          bg: 'gray.100',
          borderRadius: 'sm',
          px: '1',
          py: '0.5',
        },
        '& pre': {
          bg: 'gray.50',
          borderWidth: '1px',
          borderColor: 'gray.200',
          borderRadius: 'lg',
          px: 4,
          py: 3,
          overflowX: 'auto',
          lineHeight: 1.7,
        },
        '& pre code': { bg: 'transparent', p: 0, fontSize: 'xs', whiteSpace: 'pre', overflowWrap: 'normal' },
        '& table': { borderCollapse: 'collapse', fontSize: 'sm', w: 'max-content' },
        '& th, & td': { borderWidth: '1px', borderColor: 'gray.200', px: 3, py: 1.5 },
        '& th': { bg: 'gray.50', fontWeight: 600 },
        '& .katex': { fontSize: '1.1em' },
        // 长公式在自身区域内横向滚动，页面不出现横向溢出。
        '& .katex-display': { overflowX: 'auto', overflowY: 'hidden', py: 1 },
        '& .katex-display > .katex': { whiteSpace: 'nowrap' },
        '& .katex-error': { color: 'red.600' },
      }}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {source}
      </ReactMarkdown>
    </Box>
  );
});
