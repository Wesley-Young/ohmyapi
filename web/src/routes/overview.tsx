import { Button, Grid, HStack, Stack, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useSearchParams } from 'react-router';

import ModelUsage from '../components/model-usage';
import { ErrorText, FormDialog, Loading, PageControls, Panel, Title } from '../components/ui';
import UsageTrend from '../components/usage-trend';
import UserUsage from '../components/user-usage';
import { ViewSwitch } from '../components/view-switch';
import { Ledger } from '../components/wallet';
import { useAuth } from '../lib/auth';
import { displayMoney, formatCount, formError } from '../lib/format';
import { brandColor } from '../lib/theme';
import { trpc } from '../lib/trpc';

function LedgerDialog({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState(0);
  const ledger = useQuery(
    trpc.wallet.ledger.queryOptions({ page }, { refetchOnMount: 'always', refetchInterval: 10000 }),
  );
  return (
    <FormDialog open onClose={onClose} title="账户流水" size="xl">
      <Stack gap="4">
        <HStack justify="end">
          <Button size="sm" variant="outline" loading={ledger.isFetching} onClick={() => void ledger.refetch()}>
            刷新
          </Button>
        </HStack>
        <ErrorText>{formError(ledger.error)?.message}</ErrorText>
        {ledger.isPending ? (
          <Loading />
        ) : (
          ledger.data && (
            <>
              <Ledger items={ledger.data.items} />
              <PageControls page={page} hasMore={ledger.data.hasMore} onPage={setPage} />
            </>
          )
        )}
      </Stack>
    </FormDialog>
  );
}

function balanceAmount(value: string) {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  const cents = (micros + 5_000n) / 10_000n;
  return `${negative && cents !== 0n ? '-' : ''}${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function StatCard({ label, value, unit, action }: { label: string; value: string; unit?: string; action?: ReactNode }) {
  return (
    <Panel>
      <Stack gap="3">
        <HStack justify="space-between" gap="3" flexWrap="wrap">
          <Text fontSize="sm" color="gray.500">
            {label}
          </Text>
          {action}
        </HStack>
        <Text
          fontSize="26px"
          fontWeight="600"
          letterSpacing="-0.03em"
          overflowWrap="anywhere"
          fontVariantNumeric="tabular-nums"
        >
          {value}
          {unit && (
            <Text as="span" fontSize="sm" fontWeight="400" color="gray.500">
              {' '}
              {unit}
            </Text>
          )}
        </Text>
      </Stack>
    </Panel>
  );
}

const views = [
  { value: 'platform', label: '平台' },
  { value: 'personal', label: '个人' },
] as const;
type View = (typeof views)[number]['value'];

export default function Overview() {
  const { data: user } = useAuth();
  const admin = user?.role === 'admin';
  const [searchParams, setSearchParams] = useSearchParams();
  // 管理员默认看平台统计；普通用户只有个人视图。
  const view: View = admin && searchParams.get('view') !== 'personal' ? 'platform' : 'personal';
  const personal = view === 'personal';
  const [viewingLedger, setViewingLedger] = useState(false);
  const personalOptions = { enabled: personal, refetchOnMount: 'always', refetchInterval: 10000 } as const;
  const wallet = useQuery(trpc.wallet.get.queryOptions(undefined, personalOptions));
  const stats = useQuery(trpc.wallet.stats.queryOptions(undefined, personalOptions));
  const trend = useQuery(trpc.wallet.trend.queryOptions(undefined, personalOptions));
  // 全站统计需要扫描时间窗口内的所有请求，刷新频率低于个人统计。
  const platformOptions = { enabled: !personal, refetchOnMount: 'always', refetchInterval: 60_000 } as const;
  const platform = useQuery(trpc.admin.stats.queryOptions(undefined, platformOptions));
  const platformTrend = useQuery(trpc.admin.trend.queryOptions(undefined, platformOptions));
  return (
    <Stack gap="7">
      <Title
        action={
          admin && (
            <ViewSwitch
              label="统计视图"
              items={views}
              value={view}
              onChange={(next) => setSearchParams(next === 'platform' ? {} : { view: next }, { replace: true })}
            />
          )
        }
      >
        总览
      </Title>
      {personal ? (
        <>
          <ErrorText>{formError(wallet.error ?? stats.error)?.message}</ErrorText>
          {wallet.isPending || stats.isPending ? (
            <Loading />
          ) : (
            wallet.data &&
            stats.data && (
              <Grid templateColumns={{ base: '1fr', sm: 'repeat(2, 1fr)', xl: 'repeat(3, 1fr)' }} gap="4">
                {[
                  { label: '近 24 小时请求数', value: formatCount(stats.data.requestCount), unit: '次' },
                  { label: '近 24 小时 Token 量', value: formatCount(stats.data.tokens) },
                  {
                    label: '钱包总余额',
                    value: balanceAmount(wallet.data.balance),
                    unit: wallet.data.currency,
                    action: (
                      <Button
                        variant="plain"
                        h="auto"
                        minW="0"
                        p="0"
                        fontSize="sm"
                        fontWeight="500"
                        color="gray.600"
                        _hover={{ color: brandColor }}
                        _focusVisible={{ outline: `2px solid ${brandColor}`, outlineOffset: '2px' }}
                        onClick={() => setViewingLedger(true)}
                      >
                        查看流水
                      </Button>
                    ),
                  },
                  {
                    label: '近 24 小时消费',
                    value: displayMoney(stats.data.chargedAmount),
                    unit: wallet.data.currency,
                  },
                  {
                    label: '近 7 天消费',
                    value: displayMoney(stats.data.last7DaysChargedAmount),
                    unit: wallet.data.currency,
                  },
                  {
                    label: '近 30 天消费',
                    value: displayMoney(stats.data.last30DaysChargedAmount),
                    unit: wallet.data.currency,
                  },
                ].map((card) => (
                  <StatCard key={card.label} {...card} />
                ))}
              </Grid>
            )
          )}
          <ErrorText>{formError(trend.error)?.message}</ErrorText>
          {trend.isPending ? (
            <Loading />
          ) : (
            trend.data && <UsageTrend days={trend.data} currency={wallet.data?.currency} />
          )}
          <ModelUsage currency={wallet.data?.currency} />
        </>
      ) : (
        <>
          <ErrorText>{formError(platform.error)?.message}</ErrorText>
          {platform.isPending ? (
            <Loading />
          ) : (
            platform.data && (
              <Grid templateColumns={{ base: '1fr', sm: 'repeat(2, 1fr)', xl: 'repeat(3, 1fr)' }} gap="4">
                {(
                  [
                    ['近 24 小时', platform.data.last24Hours],
                    ['近 30 天', platform.data.last30Days],
                  ] as const
                ).flatMap(([period, stats]) =>
                  [
                    { label: `${period}平台请求数`, value: formatCount(stats.requestCount), unit: '次' },
                    { label: `${period}平台 Token 量`, value: formatCount(stats.tokens) },
                    {
                      label: `${period}平台消费`,
                      value: displayMoney(stats.chargedAmount),
                      unit: platform.data.currency,
                    },
                  ].map((card) => <StatCard key={card.label} {...card} />),
                )}
              </Grid>
            )
          )}
          <ErrorText>{formError(platformTrend.error)?.message}</ErrorText>
          {platformTrend.isPending ? (
            <Loading />
          ) : (
            platformTrend.data && <UsageTrend days={platformTrend.data} currency={platform.data?.currency} />
          )}
          <ModelUsage scope="platform" currency={platform.data?.currency} />
          <UserUsage currency={platform.data?.currency} />
        </>
      )}
      {viewingLedger && <LedgerDialog onClose={() => setViewingLedger(false)} />}
    </Stack>
  );
}
