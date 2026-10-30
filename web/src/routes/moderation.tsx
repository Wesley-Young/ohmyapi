import { Badge, Box, Button, HStack, Stack, Table, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCheck, Eye, Settings2 } from 'lucide-react';
import { useState } from 'react';

import { IconButton } from '../components/icon-button';
import { ModerationDetail, VerdictBadge } from '../components/moderation-detail';
import { ModerationSettings } from '../components/moderation-settings';
import { ErrorText, Loading, NameAction, PageControls, pinnedColumn, Title } from '../components/ui';
import { ViewSwitch } from '../components/view-switch';
import { refreshModeration } from '../lib/cache';
import { formError, localDateTime } from '../lib/format';
import { categoryLabels } from '../lib/moderation';
import { trpc } from '../lib/trpc';

type Filter = 'alerts' | 'all';
const filters = [
  { value: 'alerts', label: '待确认预警' },
  { value: 'all', label: '全部' },
] as const;

export default function Moderation() {
  const [filter, setFilter] = useState<Filter>('alerts');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState(false);
  const settings = useQuery(trpc.admin.moderation.settings.queryOptions());
  const list = useQuery(trpc.admin.moderation.list.queryOptions({ filter, page }));
  const acknowledge = useMutation(trpc.admin.moderation.acknowledge.mutationOptions({ onSuccess: refreshModeration }));
  const items = list.data?.items ?? [];
  const alertIds = items
    .filter((item) => (item.verdict === 'suspect' || item.verdict === 'violation') && !item.acknowledgedAt)
    .map((item) => item.id);
  const current = items.find((item) => item.id === selected);
  return (
    <Stack gap="7">
      <Title
        action={
          <Button size="sm" variant="outline" disabled={!settings.data} onClick={() => setEditing(true)}>
            <Settings2 size={16} aria-hidden="true" />
            审核设置
          </Button>
        }
      >
        内容审计
      </Title>
      {editing && settings.data && <ModerationSettings settings={settings.data} onClose={() => setEditing(false)} />}
      {current && <ModerationDetail key={current.id} item={current} onClose={() => setSelected(undefined)} />}
      <HStack justify="space-between" gap="3" flexWrap="wrap">
        <ViewSwitch
          label="筛选"
          items={filters}
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setPage(0);
          }}
        />
        {filter === 'alerts' && alertIds.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            loading={acknowledge.isPending}
            onClick={() => acknowledge.mutate({ ids: alertIds })}
          >
            <CheckCheck size={16} aria-hidden="true" />
            确认本页预警
          </Button>
        )}
      </HStack>
      <ErrorText>{formError(list.error ?? settings.error ?? acknowledge.error)?.message}</ErrorText>
      {list.isPending ? (
        <Loading />
      ) : items.length ? (
        <Stack gap="4">
          <Box overflowX="auto">
            <Table.Root size="sm" whiteSpace="nowrap">
              <Table.Header>
                <Table.Row>
                  {['最后请求', '用户', '渠道', '模型', '判定', '请求数'].map((h) => (
                    <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                  ))}
                  <Table.ColumnHeader {...pinnedColumn}>操作</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {items.map((item) => {
                  const alert = alertIds.includes(item.id);
                  return (
                    <Table.Row key={item.id}>
                      <Table.Cell>
                        <NameAction aria-haspopup="dialog" onClick={() => setSelected(item.id)}>
                          {localDateTime(item.lastSeenAt)}
                        </NameAction>
                      </Table.Cell>
                      <Table.Cell>{item.user.username}</Table.Cell>
                      <Table.Cell>
                        {item.executionChannel ? `${item.entryChannel} → ${item.executionChannel}` : item.entryChannel}
                      </Table.Cell>
                      <Table.Cell>{item.requestedModel}</Table.Cell>
                      <Table.Cell>
                        <HStack gap="1.5" flexWrap="wrap">
                          <VerdictBadge item={item} />
                          {item.category && item.category !== 'none' && <Badge>{categoryLabels[item.category]}</Badge>}
                          {item.acknowledgedAt && <Badge colorPalette="gray">已确认</Badge>}
                        </HStack>
                      </Table.Cell>
                      <Table.Cell>{item.requestCount}</Table.Cell>
                      <Table.Cell {...pinnedColumn}>
                        <HStack gap="1">
                          <IconButton
                            size="sm"
                            variant="ghost"
                            aria-label="查看详情"
                            aria-haspopup="dialog"
                            onClick={() => setSelected(item.id)}
                          >
                            <Eye size={16} aria-hidden="true" />
                          </IconButton>
                          {alert && (
                            <IconButton
                              size="sm"
                              variant="ghost"
                              aria-label="确认预警"
                              disabled={acknowledge.isPending}
                              onClick={() => acknowledge.mutate({ ids: [item.id] })}
                            >
                              <CheckCheck size={16} aria-hidden="true" />
                            </IconButton>
                          )}
                        </HStack>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </Box>
          <PageControls page={page} hasMore={list.data?.hasMore ?? false} pending={list.isFetching} onPage={setPage} />
        </Stack>
      ) : (
        <Text py="8" color="gray.500" fontSize="sm">
          {filter === 'alerts' ? '暂无待确认的预警' : '暂无审计记录'}
        </Text>
      )}
    </Stack>
  );
}
