import { Box, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { displayMoney, formatCount, formError } from '../lib/format';
import { trpc } from '../lib/trpc';
import { ErrorText, Loading, Panel } from './ui';
import { ViewSwitch } from './view-switch';

const ranges = [
  { value: '24h', label: '近 24 小时' },
  { value: '30d', label: '近 30 天' },
] as const;
type Range = (typeof ranges)[number]['value'];

type Row = RouterOutputs['admin']['userRanking'][number];
const columns: { key: string; label: string; value: (row: Row) => string }[] = [
  { key: 'charged', label: '消费', value: (row) => displayMoney(row.chargedAmount) },
  { key: 'tokens', label: 'Token 量', value: (row) => formatCount(row.tokens) },
  { key: 'requests', label: '请求数', value: (row) => formatCount(row.requestCount) },
];

/** 全站用户按消费排行。 */
export default function UserUsage({ currency }: { currency?: string }) {
  const [range, setRange] = useState<Range>('24h');
  const titleId = useId();
  const usage = useQuery(
    trpc.admin.userRanking.queryOptions(
      { range },
      { refetchOnMount: 'always', refetchInterval: 60_000, placeholderData: (previous) => previous },
    ),
  );
  return (
    <Panel>
      <Stack gap="5">
        <HStack justify="space-between" gap="4" flexWrap="wrap">
          <Heading as="h2" id={titleId} fontSize="lg" fontWeight="600">
            用户消费排行
          </Heading>
          <ViewSwitch label="统计范围" items={ranges} value={range} onChange={setRange} />
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
                    <Table.ColumnHeader>用户</Table.ColumnHeader>
                    {columns.map((column) => (
                      <Table.ColumnHeader key={column.key} textAlign="end">
                        {column.key === 'charged' && currency ? `${column.label}（${currency}）` : column.label}
                      </Table.ColumnHeader>
                    ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {usage.data.map((row) => (
                    <Table.Row key={row.userId ?? 'others'}>
                      <Table.Cell color={row.username ? undefined : 'gray.500'}>
                        {row.username ?? `其他 ${row.others} 位用户`}
                      </Table.Cell>
                      {columns.map((column) => (
                        <Table.Cell key={column.key} textAlign="end" fontVariantNumeric="tabular-nums">
                          {column.value(row)}
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
