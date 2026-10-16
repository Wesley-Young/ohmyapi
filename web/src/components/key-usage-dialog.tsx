import { Code, Link, Stack, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { accessEndpointOptions, pickAccessEndpoint, storedAccessEndpointId } from '../lib/access-endpoints';
import { formError } from '../lib/format';
import { brandColor } from '../lib/theme';
import { trpc } from '../lib/trpc';
import { AccessEndpointField } from './access-endpoint-field';
import { ErrorText, FormDialog, Loading } from './ui';

export function KeyUsageDialog({ onClose }: { onClose: () => void }) {
  const configured = useQuery(trpc.keys.accessEndpoints.queryOptions());
  const [selectedId, setSelectedId] = useState(storedAccessEndpointId);
  const options = accessEndpointOptions(configured.data);
  const endpoint = pickAccessEndpoint(options, selectedId);
  const baseUrl = endpoint.baseUrl;

  return (
    <FormDialog open title="使用说明" onClose={onClose}>
      {configured.isPending ? (
        <Loading />
      ) : (
        <Stack gap="4" fontSize="sm">
          <ErrorText>{formError(configured.error)?.message}</ErrorText>
          <AccessEndpointField options={options} value={endpoint} onChange={setSelectedId} />
          <Stack gap="3">
            <Text fontWeight="600">客户端 Base URL</Text>
            {[
              { label: 'OpenAI Responses 兼容客户端', url: `${baseUrl}/v1` },
              { label: 'Anthropic Messages 兼容客户端（Claude Code 除外）', url: baseUrl },
              { label: 'Google Generative AI 兼容客户端', url: `${baseUrl}/v1beta` },
            ].map(({ label, url }) => (
              <Stack key={label} gap="1" minW="0">
                <Text color="gray.600">{label}</Text>
                <Code display="block" p="2" whiteSpace="normal" overflowWrap="anywhere">
                  {url}
                </Code>
              </Stack>
            ))}
          </Stack>
          <Text color="gray.600">设置客户端基础地址为上方的 Base URL，并且复制列表中的 API Key 到客户端配置中。</Text>
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
      )}
    </FormDialog>
  );
}
