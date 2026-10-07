import { Box, Button, Grid, Heading, HStack, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useId, useState } from 'react';

import { displayMoney } from '../lib/format';
import { Panel } from './ui';

const metrics = [
  { key: 'requestCount', label: '请求数' },
  { key: 'tokens', label: 'Token 量' },
  { key: 'chargedAmount', label: '消费' },
] as const;
type Metric = (typeof metrics)[number]['key'];

export default function UsageTrend({ days, currency }: { days: RouterOutputs['wallet']['trend']; currency?: string }) {
  const [metric, setMetric] = useState<Metric>('requestCount');
  const titleId = useId();
  const label = metrics.find((item) => item.key === metric)?.label;
  const values = days.map((day) => BigInt(day[metric].replace('.', '')));
  const maximum = values.reduce((max, value) => (value > max ? value : max), 0n);
  const points = values.map((value, index) => ({
    x: 40 + index * 100,
    y: 170 - (maximum ? Number((value * 10_000n) / maximum) / 10_000 : 0) * 140,
  }));
  const display = (value: string) =>
    metric === 'chargedAmount' ? displayMoney(value) : BigInt(value).toLocaleString('zh-CN');
  return (
    <Panel>
      <Stack gap="5">
        <HStack justify="space-between" gap="4" flexWrap="wrap">
          <Heading as="h2" id={titleId} fontSize="lg" fontWeight="600">
            近 7 天趋势
          </Heading>
          <HStack gap="1" aria-label="趋势指标">
            {metrics.map((item) => (
              <Button
                key={item.key}
                size="sm"
                variant="ghost"
                borderRadius="full"
                aria-pressed={metric === item.key}
                bg={metric === item.key ? 'gray.100' : 'transparent'}
                onClick={() => setMetric(item.key)}
              >
                {item.label}
              </Button>
            ))}
          </HStack>
        </HStack>
        <Box overflowX="auto">
          <Box minW="520px">
            <svg viewBox="0 0 680 190" width="100%" role="img" aria-labelledby={titleId}>
              <title>
                {label}
                {metric === 'chargedAmount' && currency ? `（${currency}）` : ''}趋势，逐日数值见下方
              </title>
              {[30, 100, 170].map((y) => (
                <line key={y} x1="40" x2="640" y1={y} y2={y} stroke="#e5e5e5" strokeWidth="1" />
              ))}
              <polyline
                points={points.map(({ x, y }) => `${x},${y}`).join(' ')}
                fill="none"
                stroke="#635bff"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              {points.map(({ x, y }, index) => (
                <circle key={days[index].date} cx={x} cy={y} r="4" fill="white" stroke="#635bff" strokeWidth="2">
                  <title>
                    {days[index].date}：{display(days[index][metric])}
                  </title>
                </circle>
              ))}
            </svg>
            <Grid
              templateColumns="repeat(7, minmax(0, 1fr))"
              gap="2"
              as="dl"
              aria-label={`${label}每日数据${metric === 'chargedAmount' && currency ? `（${currency}）` : ''}`}
            >
              {days.map((day) => (
                <Stack key={day.date} gap="1" textAlign="center">
                  <Text as="dt" fontSize="xs" color="gray.500">
                    {day.date.slice(5).replace('-', '/')}
                  </Text>
                  <Text as="dd" fontSize="sm" fontVariantNumeric="tabular-nums" overflowWrap="anywhere">
                    {display(day[metric])}
                  </Text>
                </Stack>
              ))}
            </Grid>
          </Box>
        </Box>
        {metric === 'chargedAmount' && currency && (
          <Text fontSize="xs" color="gray.500">
            消费单位：{currency}，仅计已结算请求
          </Text>
        )}
      </Stack>
    </Panel>
  );
}
