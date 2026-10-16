import { Badge, Box, Button, HStack, Stack, Table, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { refreshGrants } from '../lib/cache';
import { formError } from '../lib/format';
import { trpc, trpcClient } from '../lib/trpc';
import { GroupAccessActions } from './group-access';
import { GroupForm } from './group-form';
import { GroupMembersDialog } from './group-members';
import { ConfirmAction, ErrorText, FormDialog, Loading, PageControls, pinnedColumn, Section } from './ui';
import { UserDialog } from './user-dialog';

function Members({ groupId, groupName }: { groupId: string; groupName: string }) {
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState<string>();
  const members = useQuery(trpc.admin.groups.members.queryOptions({ groupId, page, search: '', membersOnly: true }));
  return (
    <Section
      title="成员"
      action={
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          管理成员
        </Button>
      }
    >
      {editing && <GroupMembersDialog groupId={groupId} groupName={groupName} onClose={() => setEditing(false)} />}
      {viewing && <UserDialog key={viewing} userId={viewing} onClose={() => setViewing(undefined)} />}
      <ErrorText>{formError(members.error)?.message}</ErrorText>
      {members.isPending ? (
        <Loading />
      ) : (
        members.data && (
          <>
            {members.data.items.length ? (
              <HStack gap="2" flexWrap="wrap">
                {members.data.items.map((user) => (
                  <Badge key={user.id} colorPalette="gray" asChild>
                    <button type="button" style={{ cursor: 'pointer' }} onClick={() => setViewing(user.id)}>
                      {user.username}
                      {user.status === 'disabled' && '（已禁用）'}
                    </button>
                  </Badge>
                ))}
              </HStack>
            ) : (
              <Text color="gray.500" fontSize="sm">
                暂无成员
              </Text>
            )}
            {(page > 0 || members.data.hasMore) && (
              <PageControls page={page} hasMore={members.data.hasMore} onPage={setPage} />
            )}
          </>
        )
      )}
    </Section>
  );
}

const channelSections = {
  grant: {
    title: '非公开渠道授权',
    hint: '授予和撤销只作用于当前成员。新成员加入时，可选择同步现有成员共有的渠道。',
    column: '成员授权',
    empty: '暂无非公开渠道',
  },
  block: {
    title: '公开渠道屏蔽',
    hint: '屏蔽和解除只作用于当前成员。被屏蔽的成员看不到也无法调用该渠道。',
    column: '成员屏蔽',
    empty: '暂无公开渠道',
  },
} as const;

type ChannelCounts = { memberCount: number; items: { id: string; name: string; enabled: boolean; count: number }[] };

function GrantedChannels({ groupId, groupName }: { groupId: string; groupName: string }) {
  const query = useQuery(trpc.admin.groups.channels.queryOptions({ groupId }));
  const data = query.data && {
    memberCount: query.data.memberCount,
    items: query.data.items.map((channel) => ({ ...channel, count: channel.granted })),
  };
  return <Channels kind="grant" groupId={groupId} groupName={groupName} query={query} data={data} />;
}

function BlockedChannels({ groupId, groupName }: { groupId: string; groupName: string }) {
  const query = useQuery(trpc.admin.groups.channelBlocks.queryOptions({ groupId }));
  const data = query.data && {
    memberCount: query.data.memberCount,
    items: query.data.items.map((channel) => ({ ...channel, count: channel.blocked })),
  };
  return <Channels kind="block" groupId={groupId} groupName={groupName} query={query} data={data} />;
}

function Channels({
  kind,
  groupId,
  groupName,
  query,
  data,
}: {
  kind: 'grant' | 'block';
  groupId: string;
  groupName: string;
  query: { error: unknown; isPending: boolean };
  data: ChannelCounts | undefined;
}) {
  const text = channelSections[kind];
  return (
    <Section title={text.title} hint={text.hint}>
      <ErrorText>{formError(query.error)?.message}</ErrorText>
      {query.isPending ? (
        <Loading />
      ) : (
        data &&
        (data.items.length ? (
          <Box overflowX="auto">
            <Table.Root size="sm" whiteSpace="nowrap">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>渠道</Table.ColumnHeader>
                  <Table.ColumnHeader {...pinnedColumn}>{text.column}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.items.map((channel) => (
                  <Table.Row key={channel.id}>
                    <Table.Cell>
                      <HStack gap="2">
                        <Text>{channel.name}</Text>
                        {!channel.enabled && <Badge colorPalette="gray">已禁用</Badge>}
                      </HStack>
                    </Table.Cell>
                    <Table.Cell {...pinnedColumn}>
                      <GroupAccessActions
                        kind={kind}
                        groupId={groupId}
                        groupName={groupName}
                        channelId={channel.id}
                        channelName={channel.name}
                        granted={channel.count}
                        members={data.memberCount}
                      />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        ) : (
          <Text color="gray.500" fontSize="sm">
            {text.empty}
          </Text>
        ))
      )}
    </Section>
  );
}

/** 管理单个用户组：成员、非公开渠道授权和公开渠道屏蔽。 */
export function GroupDialog({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const group = useQuery(trpc.admin.groups.get.queryOptions({ groupId }));
  const [renaming, setRenaming] = useState(false);
  return (
    <FormDialog open size="xl" title={group.data?.name ?? '用户组'} onClose={onClose}>
      <Stack gap="6">
        <ErrorText>{formError(group.error)?.message}</ErrorText>
        {group.isPending ? (
          <Loading />
        ) : (
          group.data && (
            <>
              <HStack justify="space-between" align="start" gap="3" flexWrap="wrap">
                <Badge>{group.data.memberCount} 人</Badge>
                <HStack gap="3" flexWrap="wrap">
                  <Button size="sm" variant="outline" onClick={() => setRenaming(true)}>
                    重命名
                  </Button>
                  <ConfirmAction
                    label="删除用户组"
                    danger
                    description={`删除用户组「${group.data.name}」后，成员已有的渠道授权和屏蔽保持不变。`}
                    action={() => trpcClient.admin.groups.delete.mutate({ groupId })}
                    onSuccess={async () => {
                      onClose();
                      await refreshGrants();
                    }}
                  />
                </HStack>
              </HStack>
              {renaming && <GroupForm group={group.data} onClose={() => setRenaming(false)} />}
              <Members groupId={groupId} groupName={group.data.name} />
              <GrantedChannels groupId={groupId} groupName={group.data.name} />
              <BlockedChannels groupId={groupId} groupName={group.data.name} />
            </>
          )
        )}
      </Stack>
    </FormDialog>
  );
}
