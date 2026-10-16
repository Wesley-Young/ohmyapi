import { Badge, Button, Checkbox, HStack, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

import { refreshGrants } from '../lib/cache';
import { formError } from '../lib/format';
import { trpc } from '../lib/trpc';
import { ErrorText, FormDialog, FormInput, Loading, PageControls, PrimaryButton, Section } from './ui';

function SyncCheckbox({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <Stack gap="2">
      <Checkbox.Root
        checked={checked}
        disabled={disabled}
        onCheckedChange={(event) => onChange(event.checked === true)}
      >
        <Checkbox.HiddenInput />
        <Checkbox.Control />
        <Checkbox.Label>同步共有渠道</Checkbox.Label>
      </Checkbox.Root>
      {children}
    </Stack>
  );
}

/** 维护组成员；可为新成员同步组内原有成员共有的渠道授权和屏蔽。 */
export function GroupMembersDialog({
  groupId,
  groupName,
  onClose,
}: {
  groupId: string;
  groupName: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [draftSearch, setDraftSearch] = useState('');
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [sync, setSync] = useState(true);
  const data = useQuery(trpc.admin.groups.members.queryOptions({ groupId, page, search }));
  const shared = useQuery(trpc.admin.groups.sharedChannels.queryOptions({ groupId }));
  const task = useMutation(
    trpc.admin.groups.setMembers.mutationOptions({
      onSuccess: async () => {
        await refreshGrants();
        onClose();
      },
    }),
  );
  const changes = Object.entries(draft).map(([userId, member]) => ({ userId, member }));
  const adding = changes.some((change) => change.member);
  return (
    <FormDialog open title={`「${groupName}」成员`} onClose={onClose} busy={task.isPending}>
      <Stack gap="5">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (task.isPending) return;
            setPage(0);
            setSearch(draftSearch.trim());
          }}
        >
          <HStack align="end">
            <FormInput
              label="搜索用户名"
              value={draftSearch}
              maxLength={64}
              disabled={task.isPending}
              onChange={(event) => setDraftSearch(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={task.isPending} flexShrink="0">
              搜索
            </Button>
          </HStack>
        </form>
        <ErrorText>{formError(data.error ?? shared.error ?? task.error)?.message}</ErrorText>
        {data.isPending ? (
          <Loading />
        ) : (
          data.data && (
            <>
              <Stack gap="3" as="fieldset">
                <Text as="legend" fontSize="sm" fontWeight="500" mb="3">
                  成员
                </Text>
                {data.data.items.map((user) => (
                  <Checkbox.Root
                    key={user.id}
                    checked={draft[user.id] ?? user.member}
                    disabled={task.isPending}
                    onCheckedChange={(event) => {
                      task.reset();
                      setDraft((previous) => {
                        const next = { ...previous };
                        const member = event.checked === true;
                        if (member === user.member) delete next[user.id];
                        else next[user.id] = member;
                        return next;
                      });
                    }}
                  >
                    <Checkbox.HiddenInput />
                    <Checkbox.Control />
                    <Checkbox.Label>
                      <HStack as="span" gap="2" flexWrap="wrap">
                        <Text as="span" overflowWrap="anywhere">
                          {user.username}
                        </Text>
                        {user.status === 'disabled' && <Badge colorPalette="gray">已禁用</Badge>}
                      </HStack>
                    </Checkbox.Label>
                  </Checkbox.Root>
                ))}
                {!data.data.items.length && (
                  <Text color="gray.500" fontSize="sm">
                    没有匹配的用户
                  </Text>
                )}
              </Stack>
              <PageControls page={page} hasMore={data.data.hasMore} pending={task.isPending} onPage={setPage} />
            </>
          )
        )}
        {adding && (
          <SyncCheckbox checked={sync} disabled={task.isPending} onChange={setSync}>
            {sync && shared.data && (
              <HStack gap="2" flexWrap="wrap">
                {shared.data.map((channel) => (
                  <Badge key={`${channel.blocked}-${channel.id}`} colorPalette={channel.blocked ? 'red' : 'gray'}>
                    {channel.blocked ? `屏蔽 ${channel.name}` : channel.name}
                  </Badge>
                ))}
                {!shared.data.length && (
                  <Text fontSize="sm" color="gray.500">
                    现有成员没有共有的渠道授权或屏蔽
                  </Text>
                )}
              </HStack>
            )}
          </SyncCheckbox>
        )}
        <HStack gap="3" flexWrap="wrap">
          <PrimaryButton
            loading={task.isPending}
            disabled={!changes.length || !data.data || data.isError}
            onClick={() => task.mutate({ groupId, changes, sync: adding && sync })}
          >
            保存成员
          </PrimaryButton>
          <Button variant="ghost" disabled={task.isPending} onClick={onClose}>
            取消
          </Button>
          {changes.length > 0 && (
            <Text fontSize="sm" color="gray.500" role="status">
              已修改 {changes.length} 个用户
            </Text>
          )}
        </HStack>
      </Stack>
    </FormDialog>
  );
}

/** 用户详情中的所属用户组。 */
export function UserGroups({ userId }: { userId: string }) {
  const groups = useQuery(trpc.admin.groups.list.queryOptions());
  const current = useQuery(trpc.admin.groups.userGroups.queryOptions({ userId }));
  const [draft, setDraft] = useState<string[]>();
  const [sync, setSync] = useState(true);
  const task = useMutation(
    trpc.admin.groups.setUserGroups.mutationOptions({
      onSuccess: async () => {
        await refreshGrants();
        setDraft(undefined);
      },
    }),
  );
  const selected = draft ?? current.data?.map((group) => group.id) ?? [];
  const joining = selected.some((id) => !current.data?.some((group) => group.id === id));
  return (
    <Section title="用户组">
      <Stack gap="5">
        <ErrorText>{formError(groups.error ?? current.error ?? task.error)?.message}</ErrorText>
        {groups.isPending || current.isPending ? (
          <Loading />
        ) : (
          groups.data &&
          current.data && (
            <>
              {groups.data.map((group) => (
                <Checkbox.Root
                  key={group.id}
                  checked={selected.includes(group.id)}
                  disabled={task.isPending}
                  onCheckedChange={(event) => {
                    task.reset();
                    setDraft(event.checked ? [...selected, group.id] : selected.filter((id) => id !== group.id));
                  }}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label overflowWrap="anywhere">{group.name}</Checkbox.Label>
                </Checkbox.Root>
              ))}
              {!groups.data.length && (
                <Text color="gray.500" fontSize="sm">
                  暂无用户组
                </Text>
              )}
              {draft !== undefined && joining && (
                <SyncCheckbox checked={sync} disabled={task.isPending} onChange={setSync}>
                  <Text fontSize="sm" color="gray.500">
                    同步新加入的组中现有成员共有的渠道授权和屏蔽
                  </Text>
                </SyncCheckbox>
              )}
              <HStack gap="3" flexWrap="wrap">
                <PrimaryButton
                  alignSelf="start"
                  loading={task.isPending}
                  disabled={draft === undefined}
                  onClick={() => task.mutate({ userId, groupIds: selected, sync: joining && sync })}
                >
                  保存用户组
                </PrimaryButton>
                {task.isSuccess && (
                  <Text role="status" fontSize="sm">
                    {task.data.syncedChannels ? `已保存，同步了 ${task.data.syncedChannels} 个渠道` : '用户组已保存'}
                  </Text>
                )}
              </HStack>
            </>
          )
        )}
      </Stack>
    </Section>
  );
}
