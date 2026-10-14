import { Box, HStack, Stack, Table, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Settings2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';

import { GroupForm } from '../components/group-form';
import { IconButton } from '../components/icon-button';
import { ConfirmAction, ErrorText, Loading, NameAction, PrimaryButton, Title } from '../components/ui';
import { refreshGrants } from '../lib/cache';
import { formError, localDate } from '../lib/format';
import { trpc, trpcClient } from '../lib/trpc';

export default function Groups() {
  const navigate = useNavigate();
  const data = useQuery(trpc.admin.groups.list.queryOptions());
  const [edit, setEdit] = useState<{ id?: string; name: string }>();
  return (
    <Stack gap="7">
      <Title
        action={
          <PrimaryButton size="sm" onClick={() => setEdit({ name: '' })}>
            创建用户组
          </PrimaryButton>
        }
      >
        用户组
      </Title>
      {edit && (
        <GroupForm
          key={edit.id ?? 'new'}
          group={edit.id ? { id: edit.id, name: edit.name } : undefined}
          onClose={() => setEdit(undefined)}
          onSaved={(group) => {
            if (!edit.id) navigate(`/console/groups/${group.id}`);
          }}
        />
      )}
      <ErrorText>{formError(data.error)?.message}</ErrorText>
      {data.isPending ? (
        <Loading />
      ) : (
        data.data &&
        (data.data.length ? (
          <Box overflowX="auto">
            <Table.Root size="sm">
              <Table.Header>
                <Table.Row>
                  {['名称', '成员数', '创建时间', '操作'].map((h) => (
                    <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                  ))}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.data.map((group) => (
                  <Table.Row key={group.id}>
                    <Table.Cell>
                      <NameAction asChild>
                        <RouterLink to={`/console/groups/${group.id}`}>{group.name}</RouterLink>
                      </NameAction>
                    </Table.Cell>
                    <Table.Cell>{group.memberCount}</Table.Cell>
                    <Table.Cell whiteSpace="nowrap">{localDate(group.createdAt)}</Table.Cell>
                    <Table.Cell>
                      <HStack gap="1">
                        <IconButton size="sm" variant="ghost" aria-label={`管理「${group.name}」`} asChild>
                          <RouterLink to={`/console/groups/${group.id}`}>
                            <Settings2 size={16} aria-hidden="true" />
                          </RouterLink>
                        </IconButton>
                        <IconButton
                          size="sm"
                          variant="ghost"
                          aria-label={`重命名「${group.name}」`}
                          onClick={() => setEdit(group)}
                        >
                          <Pencil size={16} aria-hidden="true" />
                        </IconButton>
                        <ConfirmAction
                          label="删除"
                          icon={<Trash2 size={16} aria-hidden="true" />}
                          danger
                          description={`删除用户组「${group.name}」后，成员已有的渠道授权保持不变。`}
                          action={() => trpcClient.admin.groups.delete.mutate({ groupId: group.id })}
                          onSuccess={refreshGrants}
                        />
                      </HStack>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        ) : (
          <Text py="8" color="gray.500" fontSize="sm">
            暂无用户组
          </Text>
        ))
      )}
    </Stack>
  );
}
