import { Box, Button, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { displayMoney, formatCount, formError } from '../lib/format';
import { trpc } from '../lib/trpc';
import { ErrorText, Loading, Panel } from './ui';

const ranges = [
  { key: '24h', label: '近 24 小时' },
  { key: '30d', label: '近 30 天' },
] as const;
type Range = (typeof ranges)[number]['key'];

const micros = (amount: string) => BigInt(amount.replace('.', ''));

function share(value: bigint, total: bigint) {
  if (!total) return '—';
  const permille = (value * 1000n + total / 2n) / total;
  return `${permille / 10n}.${permille % 10n}%`;
}

type Row = RouterOutputs['wallet']['models'][number];
type Scope = 'self' | 'platform';
// 个人关心钱花在哪个模型，占比按消费；全站看调用量排行，占比按请求数。
const shareOf: Record<Scope, (row: Row) => bigint> = {
  self: (row) => micros(row.chargedAmount),
  platform: (row) => BigInt(row.requestCount),
};
const columns: { key: string; label: string; value: (row: Row, total: bigint, scope: Scope) => string }[] = [
  { key: 'requests', label: '请求数', value: (row) => formatCount(row.requestCount) },
  { key: 'tokens', label: 'Token 量', value: (row) => formatCount(row.tokens) },
  { key: 'charged', label: '消费', value: (row) => displayMoney(row.chargedAmount) },
  { key: 'share', label: '占比', value: (row, total, scope) => share(shareOf[scope](row), total) },
];

export default function ModelUsage({ currency, scope = 'self' }: { currency?: string; scope?: Scope }) {
  const [range, setRange] = useState<Range>('24h');
  const titleId = useId();
  const endpoint = scope === 'platform' ? trpc.admin.models : trpc.wallet.models;
  const usage = useQuery(
    endpoint.queryOptions(
      { range },
      {
        refetchOnMount: 'always',
        refetchInterval: scope === 'platform' ? 60_000 : 10_000,
        placeholderData: (previous) => previous,
      },
    ),
  );
  const total = usage.data?.reduce((sum, row) => sum + shareOf[scope](row), 0n) ?? 0n;
  return (
    <Panel>
      <Stack gap="5">
        <HStack justify="space-between" gap="4" flexWrap="wrap">
          <Heading as="h2" id={titleId} fontSize="lg" fontWeight="600">
            {scope === 'platform' ? '模型调用排行' : '按模型统计'}
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
              <Table.Root size="sm" whiteSpace="nowrap" aria-labelledby={titleId}>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>模型</Table.ColumnHeader>
                    {columns.map((column) => (
                      <Table.ColumnHeader key={column.key} textAlign="end">
                        {column.key === 'charged' && currency
                          ? `${column.label}（${currency}）`
                          : column.key === 'share'
                            ? scope === 'platform'
                              ? '请求占比'
                              : '消费占比'
                            : column.label}
                      </Table.ColumnHeader>
                    ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {usage.data.map((row) => (
                    <Table.Row key={row.modelId ?? (row.others ? 'others' : 'unknown')}>
                      <Table.Cell color={row.name ? undefined : 'gray.500'}>
                        {row.name ?? (row.others ? `其他 ${row.others} 个模型` : '未识别模型')}
                      </Table.Cell>
                      {columns.map((column) => (
                        <Table.Cell key={column.key} textAlign="end" fontVariantNumeric="tabular-nums">
                          {column.value(row, total, scope)}
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
