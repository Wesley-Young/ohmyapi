import { Badge, Box, Button, Grid, Heading, HStack, Spinner, Stack, Text } from '@chakra-ui/react';
import type { ReactNode } from 'react';

import { localDay, localTime } from '../lib/format';
import { type RequestItem, requestMetricColumns, requestMetrics, requestOwner } from '../lib/request-metrics';
import { ModelLabel } from './brand-icon';

function RequestRow({
  request: r,
  platform,
  selection,
  onDetail,
}: {
  onDetail: (id: string) => void;
  request: RequestItem;
  platform: boolean;
  selection?: ReactNode;
}) {
  const values = requestMetrics(r);
  const channel = r.channelName ?? r.channelId ?? '—';
  const owner = requestOwner(r, platform);
  const time = localTime.format(new Date(r.receivedAt));
  const hasIssue =
    Boolean(r.errorCode) ||
    (r.httpStatus ?? 0) >= 400 ||
    r.status === 'rejected' ||
    r.status === 'released' ||
    r.status === 'needs_review';
  return (
    <HStack
      gap="0"
      borderBottomWidth="1px"
      bg={hasIssue ? 'red.50' : undefined}
      _hover={{ bg: hasIssue ? 'red.100' : 'gray.50' }}
    >
      {selection && (
        <Box ps="2" w="8" flexShrink="0">
          {selection}
        </Box>
      )}
      <Button
        type="button"
        variant="plain"
        flex="1"
        h="auto"
        border="0"
        borderRadius="0"
        textAlign="start"
        aria-haspopup="dialog"
        onClick={() => onDetail(r.id)}
        className="request-grid"
        aria-label={`${hasIssue ? '查看异常请求详情' : '查看详情'}，${time} ${r.model} 请求 ${r.id}`}
        fontWeight="normal"
        minW="0"
        minH="9"
        py="0"
        _hover={{ bg: 'transparent' }}
      >
        <Box as="time" data-column="time">
          {time}
        </Box>
        <HStack as="span" minW="0" gap="1" overflow="hidden">
          <ModelLabel model={r.model} size={14} fontWeight="medium" css={{ '& > span': { truncate: true } }} />
          {r.status === 'forwarding' ? (
            <Spinner flexShrink="0" size="xs" role="status" aria-label="请求正在转发" />
          ) : (
            r.usageEstimate && (
              <Badge size="sm" colorPalette="orange">
                估算
              </Badge>
            )
          )}
        </HStack>
        <Text as="span" data-column="context" truncate>
          {channel}
        </Text>
        <Text as="span" data-column="context" truncate>
          {owner}
        </Text>
        {requestMetricColumns.map(({ key, group }) => {
          const metric = values[key];
          const color = 'color' in metric ? metric.color : undefined;
          return (
            <Text
              as="span"
              key={key}
              data-column={group}
              textAlign="end"
              truncate
              color={color ?? (metric.value === '—' || metric.value === '0' ? 'gray.500' : undefined)}
            >
              {metric.value}
            </Text>
          );
        })}
        <Text as="span" textAlign="end" truncate>
          {r.chargedAmount ?? '—'}
        </Text>
      </Button>
    </HStack>
  );
}

export function RequestTable({
  items,
  currency,
  platform,
  selectPage,
  selectRow,
  onDetail,
}: {
  onDetail: (id: string) => void;
  items: RequestItem[];
  currency: string;
  platform: boolean;
  selectPage?: ReactNode;
  selectRow?: (r: RequestItem) => ReactNode;
}) {
  const days = new Map<string, RequestItem[]>();
  for (const r of items) {
    const day = localDay.format(new Date(r.receivedAt));
    const group = days.get(day);
    if (group) group.push(r);
    else days.set(day, [r]);
  }
  return (
    <Box minW="0" containerType="inline-size">
      <Stack
        gap="6"
        minW="0"
        fontVariantNumeric="tabular-nums"
        css={{
          '--request-columns':
            '5ch minmax(0, 2fr) minmax(0, 1.4fr) minmax(0, 1fr) repeat(3, minmax(7ch, .7fr)) 5ch repeat(2, 7ch) 10ch',
          '& .request-grid': {
            display: 'grid',
            gridTemplateColumns: 'var(--request-columns)',
            gap: '3',
            px: '3',
            alignItems: 'center',
            whiteSpace: 'nowrap',
            fontSize: 'sm',
          },
          '@media (pointer: coarse)': { '& button.request-grid': { minH: '44px' } },
          '@container (max-width: 1030px)': {
            '--request-columns': '5ch minmax(0, 1fr) repeat(3, 7ch) 5ch repeat(2, 7ch) 10ch',
            '& [data-column="context"]': { display: 'none' },
          },
          '@container (max-width: 680px)': {
            '--request-columns': '5ch minmax(0, 1fr) repeat(4, 6ch) 9ch',
            '& [data-column="throughput"]': { display: 'none' },
            '& .request-grid': { gap: '1.5', px: '1.5' },
          },
          '@container (max-width: 510px)': {
            '--request-columns': '5ch minmax(0, 1fr) repeat(2, 6ch) 9ch',
            '& [data-column="tokens"]': { display: 'none' },
          },
          '@container (max-width: 399px)': {
            '--request-columns': '5ch minmax(0, 1fr) 6ch 9ch',
            '& [data-column="first"]': { display: 'none' },
          },
          '@container (max-width: 350px)': {
            '--request-columns': '5ch minmax(0, 1fr) 9ch',
            '& [data-column="total"]': { display: 'none' },
          },
          '@container (max-width: 270px)': {
            '--request-columns': 'minmax(0, 1fr) 9ch',
            '& [data-column="time"]': { display: 'none' },
          },
        }}
      >
        {[...days].map(([day, requests], index) => (
          <Stack key={day} as="section" aria-label={day} gap="2" minW="0">
            <Heading as="h2" size="sm">
              {day}
            </Heading>
            <Box>
              <HStack gap="0" borderBottomWidth="1px">
                {selectRow && (
                  <Box ps="2" w="8" flexShrink="0">
                    {index === 0 && selectPage}
                  </Box>
                )}
                <Grid
                  className="request-grid"
                  flex="1"
                  minW="0"
                  py="2"
                  color="gray.600"
                  css={{ '& > p': { fontSize: 'xs' } }}
                >
                  <Text data-column="time">时间</Text>
                  <Text>模型</Text>
                  <Text data-column="context">渠道</Text>
                  <Text data-column="context">{platform ? '用户' : 'API Key'}</Text>
                  {requestMetricColumns.map(({ key, label, group }) => (
                    <Text key={key} data-column={group} textAlign="end">
                      {label}
                    </Text>
                  ))}
                  <Text textAlign="end">扣费（{currency}）</Text>
                </Grid>
              </HStack>
              {requests.map((r) => (
                <RequestRow key={r.id} request={r} platform={platform} selection={selectRow?.(r)} onDetail={onDetail} />
              ))}
            </Box>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}
