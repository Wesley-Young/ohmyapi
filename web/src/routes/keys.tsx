import { Badge, Box, Button, Grid, HStack, Menu, Portal, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BookOpen, Check, ChevronDown, Copy, Download, Pencil, Trash2 } from 'lucide-react';
import { Fragment, useState } from 'react';

import { CCSwitchDialog } from '../components/cc-switch-dialog';
import { IconButton } from '../components/icon-button';
import { KeyForm } from '../components/key-form';
import { KeyUsageDialog } from '../components/key-usage-dialog';
import { OhmyswitchDialog } from '../components/ohmyswitch-dialog';
import { ErrorText, Loading, NameAction, PageControls, PrimaryButton, pinnedColumn, Title } from '../components/ui';
import { supportsCCSwitch } from '../lib/cc-switch';
import { displayMoney, formError, localDate } from '../lib/format';
import { ohmyswitchEndpointsOf } from '../lib/ohmyswitch';
import { queryClient, trpc } from '../lib/trpc';

type ApiKey = RouterOutputs['keys']['list']['items'][number];

const exportTargets = [
  { id: 'ohmyswitch', label: 'ohmyswitch', supports: (endpoints) => ohmyswitchEndpointsOf(endpoints).length > 0 },
  { id: 'cc-switch', label: 'CC Switch', supports: supportsCCSwitch },
] as const satisfies readonly { id: string; label: string; supports: (endpoints: ApiKey['endpoints']) => boolean }[];

type ExportTarget = (typeof exportTargets)[number]['id'];

function ExportMenu({
  apiKey,
  disabled,
  onSelect,
}: {
  apiKey: ApiKey;
  disabled: boolean;
  onSelect: (target: ExportTarget) => void;
}) {
  const available = exportTargets.filter((target) => target.supports(apiKey.endpoints));
  return (
    <Menu.Root
      positioning={{ placement: 'bottom-end' }}
      onSelect={({ value }) => {
        const target = available.find((item) => item.id === value);
        if (target) onSelect(target.id);
      }}
    >
      <Menu.Trigger asChild>
        <Button
          type="button"
          aria-label={`导出「${apiKey.name}」`}
          variant="outline"
          size="sm"
          disabled={disabled || !available.length}
        >
          <Download size={16} aria-hidden="true" />
          导出
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="160px" borderRadius="xl">
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel fontSize="xs" color="gray.500">
                导出到
              </Menu.ItemGroupLabel>
              {exportTargets.map((target) => (
                <Menu.Item key={target.id} value={target.id} borderRadius="lg" disabled={!available.includes(target)}>
                  {target.label}
                </Menu.Item>
              ))}
            </Menu.ItemGroup>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

export default function Keys() {
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [showingUsage, setShowingUsage] = useState(false);
  const [exporting, setExporting] = useState<{ keyId: string; target: ExportTarget }>();
  const data = useQuery(trpc.keys.list.queryOptions({ page }));
  const channels = useQuery(trpc.keys.channels.queryOptions());
  const currency = useQuery(trpc.wallet.get.queryOptions()).data?.currency;
  const [copiedId, setCopiedId] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  const [editing, setEditing] = useState<ApiKey>();
  const refresh = () => queryClient.invalidateQueries(trpc.keys.pathFilter());
  const deletion = useMutation(
    trpc.keys.delete.mutationOptions({
      onSuccess: async () => {
        setCopiedId(undefined);
        setPage(0);
        await refresh();
      },
    }),
  );
  const close = () => {
    setCreating(false);
    setEditing(undefined);
  };
  return (
    <Stack gap="7">
      <Title
        action={
          <HStack gap="3" flexWrap="wrap">
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowingUsage(true)}>
              <BookOpen size={16} aria-hidden="true" />
              使用说明
            </Button>
            <PrimaryButton
              size="sm"
              onClick={() => {
                close();
                setCreating(true);
              }}
            >
              创建 Key
            </PrimaryButton>
          </HStack>
        }
      >
        API Key
      </Title>
      <ErrorText>{formError(data.error ?? channels.error)?.message}</ErrorText>
      <ErrorText>{copyError}</ErrorText>
      <ErrorText>{formError(deletion.error)?.message}</ErrorText>
      {showingUsage && <KeyUsageDialog onClose={() => setShowingUsage(false)} />}
      {exporting?.target === 'cc-switch' && (
        <CCSwitchDialog keyId={exporting.keyId} onClose={() => setExporting(undefined)} />
      )}
      {exporting?.target === 'ohmyswitch' && (
        <OhmyswitchDialog keyId={exporting.keyId} onClose={() => setExporting(undefined)} />
      )}
      {(creating || editing) && (
        <KeyForm
          key={editing?.id ?? 'new'}
          editing={editing}
          onClose={close}
          onCreated={async () => {
            setCreating(false);
            setCopiedId(undefined);
            setCopyError(undefined);
            setPage(0);
            await refresh();
          }}
        />
      )}
      {data.isPending ? (
        <Loading />
      ) : (
        data.data && (
          <>
            <Box overflowX="auto">
              <Table.Root size="sm" whiteSpace="nowrap">
                <Table.Header>
                  <Table.Row>
                    {['名称', 'Key', '渠道', '有效期', '状态', currency ? `消费（${currency}）` : '消费'].map((h) => (
                      <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                    ))}
                    <Table.ColumnHeader {...pinnedColumn}>操作</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.data.items.map((key) => {
                    const expired = key.expiresAt !== null && new Date(key.expiresAt).getTime() <= Date.now();
                    return (
                      <Table.Row key={key.id}>
                        <Table.Cell>
                          {key.revokedAt ? (
                            <Text>{key.name}</Text>
                          ) : (
                            <NameAction
                              aria-haspopup="dialog"
                              disabled={deletion.isPending}
                              onClick={() => {
                                close();
                                setEditing(key);
                              }}
                            >
                              {key.name}
                            </NameAction>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          <HStack gap="2">
                            <Text as="span" fontFamily="mono">
                              {key.token.slice(0, 12)}…
                            </Text>
                            <IconButton
                              variant="ghost"
                              size="xs"
                              aria-label={
                                copiedId === key.id ? `已复制「${key.name}」的 Key` : `复制「${key.name}」的 Key`
                              }
                              title={copiedId === key.id ? '已复制' : '复制 Key'}
                              onClick={async () => {
                                setCopyError(undefined);
                                setCopiedId(undefined);
                                try {
                                  await navigator.clipboard.writeText(key.token);
                                  setCopiedId(key.id);
                                } catch {
                                  setCopyError('复制失败，请检查浏览器剪贴板权限后重试');
                                }
                              }}
                            >
                              {copiedId === key.id ? (
                                <Check size={16} strokeWidth={1.75} aria-hidden="true" focusable="false" />
                              ) : (
                                <Copy size={16} strokeWidth={1.75} aria-hidden="true" focusable="false" />
                              )}
                            </IconButton>
                          </HStack>
                        </Table.Cell>
                        <Table.Cell>
                          <HStack gap="2">
                            <Text>{key.channelName ?? '未绑定'}</Text>
                            {key.channelDeleted && <Badge colorPalette="gray">已删除</Badge>}
                          </HStack>
                        </Table.Cell>
                        <Table.Cell>{key.expiresAt ? localDate(key.expiresAt) : '长期'}</Table.Cell>
                        <Table.Cell>
                          {key.revokedAt
                            ? '已撤销'
                            : expired
                              ? '已过期'
                              : key.channelDeleted
                                ? '渠道已删除'
                                : !key.channelId
                                  ? '待绑定'
                                  : '有效'}
                        </Table.Cell>
                        <Table.Cell>
                          <Grid
                            as="dl"
                            templateColumns="auto auto"
                            columnGap="3"
                            rowGap="0.5"
                            justifyContent="start"
                            fontVariantNumeric="tabular-nums"
                          >
                            {[
                              { label: '近 24 小时', value: key.chargedAmount24h },
                              { label: '近 30 天', value: key.chargedAmount30d },
                            ].map(({ label, value }) => (
                              <Fragment key={label}>
                                <Text as="dt" color="gray.500">
                                  {label}
                                </Text>
                                <Text as="dd">{displayMoney(value)}</Text>
                              </Fragment>
                            ))}
                          </Grid>
                        </Table.Cell>
                        <Table.Cell {...pinnedColumn}>
                          <HStack gap="2">
                            <ExportMenu
                              apiKey={key}
                              disabled={expired}
                              onSelect={(target) => setExporting({ keyId: key.id, target })}
                            />
                            <IconButton
                              aria-label={`编辑 Key「${key.name}」`}
                              title="编辑 Key"
                              variant="ghost"
                              size="sm"
                              disabled={Boolean(key.revokedAt) || deletion.isPending}
                              onClick={() => {
                                close();
                                setEditing(key);
                              }}
                            >
                              <Pencil size={16} aria-hidden="true" />
                            </IconButton>
                            <IconButton
                              variant="ghost"
                              size="sm"
                              color="red.600"
                              aria-label={`删除 Key「${key.name}」`}
                              disabled={deletion.isPending}
                              loading={deletion.isPending && deletion.variables?.keyId === key.id}
                              onClick={() => deletion.mutate({ keyId: key.id })}
                            >
                              <Trash2 size={16} aria-hidden="true" />
                            </IconButton>
                          </HStack>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
            </Box>
            {!data.data.items.length && (
              <Text color="gray.500" py="8" fontSize="sm">
                暂无 Key
              </Text>
            )}
            <PageControls page={page} hasMore={data.data.hasMore} onPage={setPage} />
          </>
        )
      )}
    </Stack>
  );
}
