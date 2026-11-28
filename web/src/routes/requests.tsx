import { Button, Checkbox, HStack, Menu, Portal, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { Fragment, useState } from 'react';
import { type SetURLSearchParams, useSearchParams } from 'react-router';

import { BillingAction, BulkBilling } from '../components/billing-review';
import { RequestDetail } from '../components/request-detail';
import { RequestFilterBar } from '../components/request-filters';
import { RequestTable } from '../components/request-table';
import { useReviewCount } from '../components/review-badge';
import { ErrorText, Loading, PageControls, Title } from '../components/ui';
import { ViewSwitch } from '../components/view-switch';
import { useAuth } from '../lib/auth';
import { formError } from '../lib/format';
import {
  type RequestFilters,
  type RequestSection,
  readRequestFilters,
  requestSections,
  requestTimeBounds,
  writeRequestFilters,
} from '../lib/request-filters';
import { trpc } from '../lib/trpc';

const views = [
  { value: 'platform', label: '平台' },
  { value: 'personal', label: '个人' },
] as const;
type View = (typeof views)[number]['value'];

function RequestListMenu({
  section,
  platform,
  onChange,
}: {
  section: RequestSection;
  platform: boolean;
  onChange: (section: RequestSection) => void;
}) {
  const reviews = useReviewCount(platform);
  const sections: RequestSection[] = platform ? ['regular', 'decisions', 'review'] : ['regular', 'decisions'];
  return (
    <Menu.Root positioning={{ placement: 'bottom-start' }}>
      <Menu.Trigger asChild>
        <Button
          type="button"
          variant="plain"
          p="0"
          h="auto"
          gap="1.5"
          font="inherit"
          letterSpacing="inherit"
          color="inherit"
          aria-label={`切换请求列表，当前为${requestSections[section]}`}
        >
          {requestSections[section]}
          <ChevronDown size={18} color="var(--chakra-colors-gray-500)" aria-hidden="true" />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content>
            <Menu.RadioItemGroup
              value={section}
              onValueChange={({ value }) => {
                const next = sections.find((item) => item === value);
                if (next) onChange(next);
              }}
            >
              {sections.map((item) => (
                <Fragment key={item}>
                  {item === 'review' && <Menu.Separator />}
                  <Menu.RadioItem value={item}>
                    <Menu.ItemText>{requestSections[item]}</Menu.ItemText>
                    {item === 'review' && (
                      <Text as="span" ms="auto" fontSize="xs" color="gray.600" fontVariantNumeric="tabular-nums">
                        {reviews}
                      </Text>
                    )}
                    <Menu.ItemIndicator />
                  </Menu.RadioItem>
                </Fragment>
              ))}
            </Menu.RadioItemGroup>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

export default function Requests() {
  const { data: user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [searchRevision, setSearchRevision] = useState(0);
  if (!user) return null;
  const admin = user.role === 'admin';
  const view: View = admin && params.get('view') !== 'personal' ? 'platform' : 'personal';
  const filters = readRequestFilters(params, view === 'platform');
  const platform = view === 'platform';
  const switchView = (next: View) => {
    const search = writeRequestFilters(params, { ...filters, userId: '', channelId: '', apiKeyId: '' });
    search.delete('reviewOnly');
    if (next === 'personal') search.set('view', next);
    else search.delete('view');
    setParams(search);
  };
  return (
    <Stack gap="7">
      <Title action={admin && <ViewSwitch label="请求视图" items={views} value={view} onChange={switchView} />}>
        <RequestListMenu
          section={filters.section}
          platform={platform}
          onChange={(section) => setParams(writeRequestFilters(params, { ...filters, section }))}
        />
      </Title>
      <RequestFilterBar
        applied={filters}
        platform={platform}
        onChange={(next) => {
          const search = writeRequestFilters(params, next);
          if (search.toString() === params.toString()) setSearchRevision((value) => value + 1);
          else setParams(search, { replace: true });
        }}
      />
      <RequestList
        key={JSON.stringify([view, filters, searchRevision])}
        user={user}
        view={view}
        filters={filters}
        params={params}
        setParams={setParams}
      />
    </Stack>
  );
}

function RequestList({
  user,
  view,
  filters,
  params,
  setParams,
}: {
  user: NonNullable<RouterOutputs['auth']['me']>;
  view: View;
  filters: RequestFilters;
  params: URLSearchParams;
  setParams: SetURLSearchParams;
}) {
  const [action, setAction] = useState<{ requestId: string; kind: 'resolve' | 'correct' }>();
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [resolved, setResolved] = useState<{ usage: number; zero: number; manual: number }>();
  const admin = user.role === 'admin';
  const platform = view === 'platform';
  const bounds = requestTimeBounds(filters);
  const reviewing = filters.section === 'review';
  const common = {
    page,
    group: filters.section === 'review' ? undefined : filters.section,
    model: filters.model.trim() || undefined,
    ...bounds,
  };
  const detailId = params.get('request');
  const setDetailId = (id?: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('request', id);
    else next.delete('request');
    setParams(next, { replace: true });
  };
  const own = useQuery(
    trpc.requests.queryOptions(
      { ...common, apiKeyId: filters.apiKeyId || undefined },
      {
        enabled: !!bounds && !platform,
        staleTime: 0,
        refetchInterval: 5000,
      },
    ),
  );
  const all = useQuery(
    trpc.admin.requests.queryOptions(
      {
        ...common,
        userId: filters.userId || undefined,
        channelId: filters.channelId || undefined,
        reviewOnly: reviewing,
      },
      {
        enabled: !!bounds && platform,
        staleTime: 0,
        refetchInterval: 5000,
      },
    ),
  );
  const data = platform ? all : own;
  const selectable = data.data?.items.filter((r) => r.billingEnabled && r.status === 'needs_review') ?? [];
  const pageIds = selectable.map((r) => r.id);
  const selectedOnPage = pageIds.filter((id) => selectedIds.includes(id)).length;
  return (
    <Stack gap="7">
      {admin && reviewing && (
        <HStack gap="3" flexWrap="wrap">
          <Text fontSize="sm" color="gray.600">
            已选 {selectedIds.length} / 100
          </Text>
          <BulkBilling
            key={user.id}
            requestIds={selectedIds}
            onSuccess={(result) => {
              setSelectedIds([]);
              setResolved(result);
            }}
          />
          {selectedIds.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>
              清空选择
            </Button>
          )}
          {resolved && (
            <Text fontSize="sm" color="gray.600" role="status">
              已按用量结算 {resolved.usage} 个，按 0 结算 {resolved.zero} 个
              {resolved.manual > 0 && `，${resolved.manual} 个需逐条核对`}
            </Text>
          )}
        </HStack>
      )}
      {detailId && !action && (
        <RequestDetail
          requestId={detailId}
          summary={data.data?.items.find((item) => item.id === detailId)}
          platform={platform}
          onBilling={(kind) => setAction({ requestId: detailId, kind })}
          close={() => setDetailId(undefined)}
        />
      )}
      {action && <BillingAction requestId={action.requestId} kind={action.kind} close={() => setAction(undefined)} />}
      <ErrorText>{formError(data.error)?.message}</ErrorText>
      {!bounds ? (
        <ErrorText>请选择有效的起止日期</ErrorText>
      ) : data.isPending ? (
        <Loading />
      ) : (
        data.data && (
          <>
            <RequestTable
              items={data.data.items}
              currency={data.data.currency}
              platform={platform}
              onDetail={setDetailId}
              selectPage={
                reviewing && (
                  <Checkbox.Root
                    checked={
                      pageIds.length > 0 && selectedOnPage === pageIds.length
                        ? true
                        : selectedOnPage > 0
                          ? 'indeterminate'
                          : false
                    }
                    disabled={
                      !pageIds.length ||
                      (selectedOnPage < pageIds.length && selectedIds.length + pageIds.length - selectedOnPage > 100)
                    }
                    onCheckedChange={(event) => {
                      setResolved(undefined);
                      setSelectedIds((ids) =>
                        event.checked === true
                          ? [...new Set([...ids, ...pageIds])].slice(0, 100)
                          : ids.filter((id) => !pageIds.includes(id)),
                      );
                    }}
                  >
                    <Checkbox.HiddenInput aria-label="选择当前页的待核对请求" />
                    <Checkbox.Control />
                  </Checkbox.Root>
                )
              }
              selectRow={
                reviewing
                  ? (r) => (
                      <Checkbox.Root
                        checked={selectedIds.includes(r.id)}
                        disabled={
                          !selectedIds.includes(r.id) &&
                          (!r.billingEnabled || r.status !== 'needs_review' || selectedIds.length >= 100)
                        }
                        onCheckedChange={(event) => {
                          setResolved(undefined);
                          setSelectedIds((ids) =>
                            event.checked === true
                              ? [...new Set([...ids, r.id])].slice(0, 100)
                              : ids.filter((id) => id !== r.id),
                          );
                        }}
                      >
                        <Checkbox.HiddenInput aria-label={`选择请求 ${r.id}`} />
                        <Checkbox.Control />
                      </Checkbox.Root>
                    )
                  : undefined
              }
            />
            {!data.data.items.length && (
              <Text fontSize="sm" color="gray.500">
                {filters.range !== 'all' || filters.model || filters.userId || filters.channelId || filters.apiKeyId
                  ? '没有符合筛选条件的请求'
                  : '暂无请求'}
              </Text>
            )}
            <PageControls page={page} hasMore={data.data.hasMore} onPage={setPage} />
          </>
        )
      )}
    </Stack>
  );
}
