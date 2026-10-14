import { Code, Link, Stack, Text } from '@chakra-ui/react';

import { brandColor } from '../lib/theme';
import { FormDialog } from './ui';

export function KeyUsageDialog({ onClose }: { onClose: () => void }) {
  const origin = window.location.origin;

  return (
    <FormDialog open title="使用说明" onClose={onClose}>
      <Stack gap="4" fontSize="sm">
        <Stack gap="3">
          <Text fontWeight="600">客户端 Base URL</Text>
          {[
            { label: 'OpenAI Responses 兼容客户端', url: `${origin}/v1` },
            { label: 'Anthropic Messages 兼容客户端（Claude Code 除外）', url: origin },
          ].map(({ label, url }) => (
            <Stack key={label} gap="1" minW="0">
              <Text color="gray.600">{label}</Text>
              <Code display="block" p="2" whiteSpace="normal" overflowWrap="anywhere">
                {url}
              </Code>
            </Stack>
          ))}
        </Stack>
        <Text color="gray.600">设置客户端基础地址到本站点，并且复制列表中的 API Key 到客户端配置中。</Text>
        <Text color="gray.600">
          点击对应 API Key 的“导出”按钮，可将配置导入{' '}
          <Link href="https://ccswitch.io/" color={brandColor}>
            CC Switch
          </Link>{' '}
          管理。
        </Text>
        <Text color="gray.600">
          本站<b>不支持 Claude Code 客户端</b>。
        </Text>
      </Stack>
    </FormDialog>
  );
}
