import { Badge, Box, Button, Heading, HStack, Link, Stack, Table, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router';

import { GroupAccessActions } from '../components/group-access';
import { GroupForm } from '../components/group-form';
import { GroupMembersDialog } from '../components/group-members';
import { ConfirmAction, ErrorText, Loading, PageControls, Panel, pinnedColumn, Title } from '../components/ui';
import { refreshGrants } from '../lib/cache';
import { formError } from '../lib/format';
import { trpc, trpcClient } from '../lib/trpc';

function Members({ groupId, groupName }: { groupId: string; groupName: string }) {
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false);
  const members = useQuery(trpc.admin.groups.members.queryOptions({ groupId, page, search: '', membersOnly: true }));
  return (
    <Panel>
      <Stack gap="5">
        <HStack justify="space-between" gap="3" flexWrap="wrap">
          <Heading as="h2" fontSize="lg">
            成员
          </Heading>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            管理成员
          </Button>
        </HStack>
        {editing && <GroupMembersDialog groupId={groupId} groupName={groupName} onClose={() => setEditing(false)} />}
        <ErrorText>{formError(members.error)?.message}</ErrorText>
        {members.isPending ? (
          <Loading />
        ) : (
          members.data && (
            <>
              {members.data.items.length ? (
                <HStack gap="2" flexWrap="wrap">
                  {members.data.items.map((user) => (
                    <Link key={user.id} asChild>
                      <RouterLink to={`/console/users/${user.id}`}>
                        <Badge colorPalette="gray">
                          {user.username}
                          {user.status === 'disabled' && '（已禁用）'}
                        </Badge>
                      </RouterLink>
                    </Link>
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
      </Stack>
    </Panel>
  );
}

function Channels({ groupId, groupName }: { groupId: string; groupName: string }) {
  const channels = useQuery(trpc.admin.groups.channels.queryOptions({ groupId }));
  return (
    <Panel>
      <Stack gap="5">
        <Stack gap="1">
          <Heading as="h2" fontSize="lg">
            非公开渠道授权
          </Heading>
          <Text fontSize="sm" color="gray.500">
            授予和撤销只作用于当前成员。新成员加入时，可选择同步现有成员共有的渠道。
          </Text>
        </Stack>
        <ErrorText>{formError(channels.error)?.message}</ErrorText>
        {channels.isPending ? (
          <Loading />
        ) : (
          channels.data &&
          (channels.data.items.length ? (
            <Box overflowX="auto">
              <Table.Root size="sm" whiteSpace="nowrap">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>渠道</Table.ColumnHeader>
                    <Table.ColumnHeader {...pinnedColumn}>成员授权</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {channels.data.items.map((channel) => (
                    <Table.Row key={channel.id}>
                      <Table.Cell>
                        <HStack gap="2">
                          <Text>{channel.name}</Text>
                          {!channel.enabled && <Badge colorPalette="gray">已禁用</Badge>}
                        </HStack>
                      </Table.Cell>
                      <Table.Cell {...pinnedColumn}>
                        <GroupAccessActions
                          groupId={groupId}
                          groupName={groupName}
                          channelId={channel.id}
                          channelName={channel.name}
                          granted={channel.granted}
                          members={channels.data.memberCount}
                        />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            <Text color="gray.500" fontSize="sm">
              暂无非公开渠道
            </Text>
          ))
        )}
      </Stack>
    </Panel>
  );
}

export default function GroupDetail() {
  const groupId = useParams().groupId ?? '';
  const navigate = useNavigate();
  const group = useQuery(trpc.admin.groups.get.queryOptions({ groupId }));
  const [renaming, setRenaming] = useState(false);
  return (
    <Stack gap="7">
      <Link asChild color="gray.500" fontSize="sm" alignSelf="start">
        <RouterLink to="/console/groups">← 用户组</RouterLink>
      </Link>
      <ErrorText>{formError(group.error)?.message}</ErrorText>
      {group.isPending ? (
        <Loading />
      ) : (
        group.data && (
          <>
            <Title
              action={
                <HStack gap="3" flexWrap="wrap">
                  <Button size="sm" variant="outline" onClick={() => setRenaming(true)}>
                    重命名
                  </Button>
                  <ConfirmAction
                    label="删除用户组"
                    danger
                    description={`删除用户组「${group.data.name}」后，成员已有的渠道授权保持不变。`}
                    action={() => trpcClient.admin.groups.delete.mutate({ groupId })}
                    onSuccess={async () => {
                      navigate('/console/groups', { replace: true });
                      await refreshGrants();
                    }}
                  />
                </HStack>
              }
            >
              <HStack gap="3" flexWrap="wrap">
                <Text>{group.data.name}</Text>
                <Badge letterSpacing="normal">{group.data.memberCount} 人</Badge>
              </HStack>
            </Title>
            {renaming && <GroupForm group={group.data} onClose={() => setRenaming(false)} />}
            <Members key={`members-${groupId}`} groupId={groupId} groupName={group.data.name} />
            <Channels key={`channels-${groupId}`} groupId={groupId} groupName={group.data.name} />
          </>
        )
      )}
    </Stack>
  );
}
