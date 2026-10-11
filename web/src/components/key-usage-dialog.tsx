import { Code, Link, Stack, Text } from '@chakra-ui/react';

import { FormDialog } from './ui';

export function KeyUsageDialog({ onClose }: { onClose: () => void }) {
  const origin = window.location.origin;

  return (
    <FormDialog open title="使用说明" onClose={onClose}>
      <Stack gap="4" fontSize="sm">
        <Stack gap="3">
          <Text fontWeight="600">客户端 Base URL</Text>
          {[
            { label: 'Codex', url: `${origin}/v1` },
            { label: 'Claude Code', url: origin },
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
          此外，也可以点击对应 API Key 的 “导出” 按钮，将配置一键导入到{' '}
          <Link href="https://ccswitch.io/" color="#656bff">
            CC Switch
          </Link>{' '}
          中。
        </Text>
      </Stack>
    </FormDialog>
  );
}
