import { Box, Grid, Heading, Link, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { Link as RouterLink } from 'react-router';

import { displayMoney, isZeroMoney, localDate } from '../lib/format';
import { brandColor } from '../lib/theme';
import { Panel } from './ui';

type Output = RouterOutputs;
export function WalletSummary({ wallet }: { wallet: Output['wallet']['get'] }) {
  // 冻结金额只来自早期请求的预占，为零时不展示。
  const cards = [
    { label: '可用余额', value: wallet.available },
    { label: '总余额', value: wallet.balance },
    ...(isZeroMoney(wallet.reserved) ? [] : [{ label: '冻结金额', value: wallet.reserved }]),
  ];
  return (
    <Grid templateColumns={{ base: '1fr', sm: `repeat(${cards.length}, 1fr)` }} gap="4">
      {cards.map(({ label, value }) => (
        <Panel key={label}>
          <Stack gap="3">
            <Text fontSize="sm" color="gray.500">
              {label}
            </Text>
            <Heading
              fontSize="26px"
              fontWeight="600"
              letterSpacing="-0.03em"
              overflowWrap="anywhere"
              fontVariantNumeric="tabular-nums"
            >
              {displayMoney(value)}{' '}
              <Text as="span" fontSize="sm" fontWeight="400" color="gray.500">
                {wallet.currency}
              </Text>
            </Heading>
          </Stack>
        </Panel>
      ))}
    </Grid>
  );
}
const kinds = { adjustment: '余额调整', reserve: '预占', settlement: '消费', release: '释放', correction: '修正' };
export function Ledger({ items }: { items: Output['wallet']['ledger']['items'] }) {
  const holds = items.some((item) => !isZeroMoney(item.reservedAmount));
  if (!items.length)
    return (
      <Text py="8" color="gray.500" fontSize="sm">
        暂无流水
      </Text>
    );
  return (
    <Box overflowX="auto">
      <Table.Root size="sm" whiteSpace="nowrap">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>时间</Table.ColumnHeader>
            <Table.ColumnHeader>类型</Table.ColumnHeader>
            <Table.ColumnHeader textAlign="end">余额变化</Table.ColumnHeader>
            {holds && <Table.ColumnHeader textAlign="end">冻结变化</Table.ColumnHeader>}
            <Table.ColumnHeader textAlign="end">余额</Table.ColumnHeader>
            <Table.ColumnHeader>原因</Table.ColumnHeader>
            <Table.ColumnHeader>操作人</Table.ColumnHeader>
            <Table.ColumnHeader>请求</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {items.map((item) => (
            <Table.Row key={item.id}>
              <Table.Cell>{localDate(item.createdAt)}</Table.Cell>
              <Table.Cell>{kinds[item.kind]}</Table.Cell>
              <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                {displayMoney(item.amount)}
              </Table.Cell>
              {holds && (
                <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                  {displayMoney(item.reservedAmount)}
                </Table.Cell>
              )}
              <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                {displayMoney(item.balanceAfter)}
              </Table.Cell>
              <Table.Cell minW="150px" maxW="340px" whiteSpace="normal" overflowWrap="anywhere">
                {item.reason || '—'}
              </Table.Cell>
              <Table.Cell>{item.actorName ?? '系统'}</Table.Cell>
              <Table.Cell>
                {item.requestId && (
                  <Link asChild color={brandColor} fontSize="xs">
                    <RouterLink to={`/console/requests?request=${item.requestId}`}>
                      {item.requestId.slice(0, 8)}
                    </RouterLink>
                  </Link>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
