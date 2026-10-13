import { Box, Button, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { displayMoney, formError } from '../lib/format';
import { trpc } from '../lib/trpc';
import { ErrorText, Loading, Panel } from './ui';

const ranges = [
  { key: '24h', label: '近 24 小时' },
  { key: '30d', label: '近 30 天' },
] as const;
type Range = (typeof ranges)[number]['key'];

const count = (value: string) => BigInt(value).toLocaleString('zh-CN');
const micros = (amount: string) => BigInt(amount.replace('.', ''));

function share(amount: string, total: bigint) {
  if (!total) return '—';
  const permille = (micros(amount) * 1000n + total / 2n) / total;
  return `${permille / 10n}.${permille % 10n}%`;
}

type Row = RouterOutputs['wallet']['models'][number];
const columns: { key: string; label: string; value: (row: Row, total: bigint) => string }[] = [
  { key: 'requests', label: '请求数', value: (row) => count(row.requestCount) },
  { key: 'tokens', label: 'Token 量', value: (row) => count(row.tokens) },
  { key: 'charged', label: '消费', value: (row) => displayMoney(row.chargedAmount) },
  { key: 'share', label: '消费占比', value: (row, total) => share(row.chargedAmount, total) },
];

export default function ModelUsage({ currency }: { currency?: string }) {
  const [range, setRange] = useState<Range>('24h');
  const titleId = useId();
  const usage = useQuery(
    trpc.wallet.models.queryOptions(
      { range },
      { refetchOnMount: 'always', refetchInterval: 10000, placeholderData: (previous) => previous },
    ),
  );
  const total = usage.data?.reduce((sum, row) => sum + micros(row.chargedAmount), 0n) ?? 0n;
  return (
    <Panel>
      <Stack gap="5">
        <HStack justify="space-between" gap="4" flexWrap="wrap">
          <Heading as="h2" id={titleId} fontSize="lg" fontWeight="600">
            按模型统计
          </Heading>
          <HStack gap="1" aria-label="统计范围">
            {ranges.map((item) => (
              <Button
                key={item.key}
                size="sm"
                variant="ghost"
                borderRadius="full"
                aria-pressed={range === item.key}
                bg={range === item.key ? 'gray.100' : 'transparent'}
                onClick={() => setRange(item.key)}
              >
                {item.label}
              </Button>
            ))}
          </HStack>
        </HStack>
        <ErrorText>{formError(usage.error)?.message}</ErrorText>
        {usage.isPending ? (
          <Loading />
        ) : (
          usage.data &&
          (usage.data.length ? (
            <Box overflowX="auto">
              <Table.Root size="sm" aria-labelledby={titleId}>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>模型</Table.ColumnHeader>
                    {columns.map((column) => (
                      <Table.ColumnHeader key={column.key} textAlign="end" whiteSpace="nowrap">
                        {column.key === 'charged' && currency ? `${column.label}（${currency}）` : column.label}
                      </Table.ColumnHeader>
                    ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {usage.data.map((row) => (
                    <Table.Row key={row.modelId ?? 'unknown'}>
                      <Table.Cell color={row.name ? undefined : 'gray.500'} overflowWrap="anywhere">
                        {row.name ?? '未识别模型'}
                      </Table.Cell>
                      {columns.map((column) => (
                        <Table.Cell
                          key={column.key}
                          textAlign="end"
                          whiteSpace="nowrap"
                          fontVariantNumeric="tabular-nums"
                        >
                          {column.value(row, total)}
                        </Table.Cell>
                      ))}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            <Text color="gray.500" py="4" fontSize="sm">
              暂无请求
            </Text>
          ))
        )}
      </Stack>
    </Panel>
  );
}
