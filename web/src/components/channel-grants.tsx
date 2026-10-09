import { Badge, Checkbox, Heading, HStack, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { formError } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';
import { ErrorText, Loading, Panel, PrimaryButton } from './ui';

export function ChannelGrants({ userId }: { userId: string }) {
  const catalog = useQuery(trpc.admin.catalog.list.queryOptions());
  const grants = useQuery(trpc.admin.catalog.grants.queryOptions({ userId }));
  const [draft, setDraft] = useState<string[]>();
  const task = useMutation(
    trpc.admin.catalog.setGrants.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries(trpc.admin.catalog.grants.queryFilter({ userId })),
          queryClient.invalidateQueries(trpc.keys.pathFilter()),
          queryClient.invalidateQueries(trpc.modelPlaza.queryFilter()),
        ]);
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
          渠道授权
        </Heading>
        <Text fontSize="sm" color="gray.500">
          公开渠道对所有用户开放。授权非公开渠道后，可使用该渠道下的全部可用模型。
        </Text>
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
            </>
          )
        )}
      </Stack>
    </Panel>
  );
}
