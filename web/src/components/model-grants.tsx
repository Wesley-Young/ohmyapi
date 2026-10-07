import { Checkbox, Heading, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { formError } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';
import { ErrorText, Loading, Panel, PrimaryButton } from './ui';

export function ModelGrants({ userId }: { userId: string }) {
  const catalog = useQuery(trpc.admin.catalog.list.queryOptions());
  const grants = useQuery(trpc.admin.catalog.grants.queryOptions({ userId }));
  const [draft, setDraft] = useState<string[]>();
  const task = useMutation(
    trpc.admin.catalog.setGrants.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries(trpc.admin.catalog.grants.queryFilter({ userId })),
          queryClient.invalidateQueries(trpc.keys.models.queryFilter()),
          queryClient.invalidateQueries(trpc.keys.channels.queryFilter()),
        ]);
        setDraft(undefined);
      },
    }),
  );
  const selected = draft ?? grants.data?.map((g) => g.modelId) ?? [];
  return (
    <Panel>
      <Stack gap="5">
        <Heading as="h2" fontSize="lg">
          非公开渠道模型授权
        </Heading>
        <Text fontSize="sm" color="gray.500">
          公开渠道对所有用户开放，以下授权仅用于非公开渠道。
        </Text>
        <ErrorText>{formError(catalog.error ?? grants.error ?? task.error)?.message}</ErrorText>
        {catalog.isPending || grants.isPending ? (
          <Loading />
        ) : (
          catalog.data &&
          grants.data && (
            <>
              {catalog.data.models.map((m) => (
                <Checkbox.Root
                  key={m.id}
                  checked={selected.includes(m.id)}
                  disabled={task.isPending}
                  onCheckedChange={(e) => {
                    task.reset();
                    setDraft(e.checked ? [...selected, m.id] : selected.filter((id) => id !== m.id));
                  }}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label>
                    {m.name}
                    {!m.enabled && '（已禁用）'}
                  </Checkbox.Label>
                </Checkbox.Root>
              ))}
              {!catalog.data.models.length && (
                <Text color="gray.500" fontSize="sm">
                  请先添加模型
                </Text>
              )}
              <PrimaryButton
                alignSelf="start"
                loading={task.isPending}
                disabled={draft === undefined}
                onClick={() => task.mutate({ userId, modelIds: selected })}
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
