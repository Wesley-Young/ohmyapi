import { Badge, Button, Checkbox, Heading, HStack, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { formError } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';
import { ErrorText, FormDialog, FormInput, Loading, PageControls, Panel, PrimaryButton } from './ui';

function refreshGrants() {
  return Promise.all([
    queryClient.invalidateQueries(trpc.admin.catalog.grants.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.catalog.channelGrants.pathFilter()),
    queryClient.invalidateQueries(trpc.keys.pathFilter()),
    queryClient.invalidateQueries(trpc.modelPlaza.queryFilter()),
  ]);
}

export function ChannelUsersDialog({
  channelId,
  channelName,
  onClose,
}: {
  channelId: string;
  channelName: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [draftSearch, setDraftSearch] = useState('');
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const data = useQuery(trpc.admin.catalog.channelGrants.queryOptions({ channelId, page, search }));
  const task = useMutation(
    trpc.admin.catalog.setChannelGrants.mutationOptions({
      onSuccess: async () => {
        await refreshGrants();
        onClose();
      },
    }),
  );
  const changes = Object.entries(draft).map(([userId, granted]) => ({ userId, granted }));
  return (
    <FormDialog open title={`「${channelName}」用户授权`} onClose={onClose} busy={task.isPending}>
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
        <ErrorText>{formError(data.error ?? task.error)?.message}</ErrorText>
        {data.isPending ? (
          <Loading />
        ) : (
          data.data && (
            <>
              <Stack gap="3" as="fieldset">
                <Text as="legend" fontSize="sm" fontWeight="500" mb="3">
                  可访问用户
                </Text>
                {data.data.items.map((user) => (
                  <Checkbox.Root
                    key={user.id}
                    checked={draft[user.id] ?? user.granted}
                    disabled={task.isPending}
                    onCheckedChange={(event) => {
                      task.reset();
                      setDraft((previous) => {
                        const next = { ...previous };
                        const granted = event.checked === true;
                        if (granted === user.granted) delete next[user.id];
                        else next[user.id] = granted;
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
        <HStack gap="3" flexWrap="wrap">
          <PrimaryButton
            loading={task.isPending}
            disabled={!changes.length || !data.data || data.isError}
            onClick={() => task.mutate({ channelId, grants: changes })}
          >
            保存授权
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

export function ChannelGrants({ userId }: { userId: string }) {
  const catalog = useQuery(trpc.admin.catalog.list.queryOptions());
  const grants = useQuery(trpc.admin.catalog.grants.queryOptions({ userId }));
  const [draft, setDraft] = useState<string[]>();
  const task = useMutation(
    trpc.admin.catalog.setGrants.mutationOptions({
      onSuccess: async () => {
        await refreshGrants();
        setDraft(undefined);
      },
    }),
  );
  const privateChannels = catalog.data?.channels.filter((channel) => !channel.isPublic) ?? [];
  const selected = draft ?? grants.data?.map((g) => g.channelId) ?? [];
  return (
    <Panel>
      <Stack gap="5">
        <Heading as="h2" fontSize="lg">
          非公开渠道授权
        </Heading>
        <ErrorText>{formError(catalog.error ?? grants.error ?? task.error)?.message}</ErrorText>
        {catalog.isPending || grants.isPending ? (
          <Loading />
        ) : (
          catalog.data &&
          grants.data && (
            <>
              {privateChannels.map((channel) => (
                <Checkbox.Root
                  key={channel.id}
                  checked={selected.includes(channel.id)}
                  disabled={task.isPending}
                  onCheckedChange={(e) => {
                    task.reset();
                    setDraft(e.checked ? [...selected, channel.id] : selected.filter((id) => id !== channel.id));
                  }}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label>
                    <HStack as="span" gap="2" flexWrap="wrap">
                      <Text as="span" overflowWrap="anywhere">
                        {channel.name}
                      </Text>
                      {!channel.enabled && <Badge colorPalette="gray">已禁用</Badge>}
                    </HStack>
                  </Checkbox.Label>
                </Checkbox.Root>
              ))}
              {!privateChannels.length && (
                <Text color="gray.500" fontSize="sm">
                  暂无非公开渠道
                </Text>
              )}
              <HStack gap="3" flexWrap="wrap">
                <PrimaryButton
                  alignSelf="start"
                  loading={task.isPending}
                  disabled={draft === undefined}
                  onClick={() => task.mutate({ userId, channelIds: selected })}
                >
                  保存授权
                </PrimaryButton>
                {task.isSuccess && (
                  <Text role="status" fontSize="sm">
                    授权已保存
                  </Text>
                )}
              </HStack>
            </>
          )
        )}
      </Stack>
    </Panel>
  );
}
