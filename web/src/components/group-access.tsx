import { Badge, Button, HStack, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { refreshGrants } from '../lib/cache';
import { formError } from '../lib/format';
import { trpc, trpcClient } from '../lib/trpc';
import { ConfirmAction, ErrorText, Loading } from './ui';

const actionText = {
  grant: { done: '已授权', apply: '授予全部', undo: '撤销全部', applyVerb: '授予', undoVerb: '授权' },
  block: { done: '已屏蔽', apply: '屏蔽全部', undo: '解除全部', applyVerb: '屏蔽', undoVerb: '屏蔽' },
} as const;

/**
 * 为组的当前成员一次性授予或撤销非公开渠道（grant），或屏蔽或解除公开渠道（block）；不改变组本身。
 */
export function GroupAccessActions({
  kind = 'grant',
  groupId,
  groupName,
  channelId,
  channelName,
  granted,
  members,
}: {
  kind?: 'grant' | 'block';
  groupId: string;
  groupName: string;
  channelId: string;
  channelName: string;
  /** 已授权（grant）或已屏蔽（block）的成员数。 */
  granted: number;
  members: number;
}) {
  const grant = useMutation(trpc.admin.groups.setChannelAccess.mutationOptions({ onSuccess: refreshGrants }));
  const block = useMutation(trpc.admin.groups.setChannelBlocks.mutationOptions({ onSuccess: refreshGrants }));
  const task = kind === 'grant' ? grant : block;
  const text = actionText[kind];
  const undo = () =>
    kind === 'grant'
      ? trpcClient.admin.groups.setChannelAccess.mutate({ groupId, channelIds: [channelId], granted: false })
      : trpcClient.admin.groups.setChannelBlocks.mutate({ groupId, channelIds: [channelId], blocked: false });
  return (
    <Stack gap="2" align="start">
      <HStack gap="2" flexWrap="wrap">
        <Badge colorPalette={members > 0 && granted === members ? (kind === 'grant' ? 'green' : 'red') : 'gray'}>
          {text.done} {granted}/{members}
        </Badge>
        <Button
          size="sm"
          variant="outline"
          aria-label={`为「${groupName}」全部成员${text.applyVerb}「${channelName}」`}
          disabled={granted >= members}
          loading={task.isPending}
          onClick={() =>
            kind === 'grant'
              ? grant.mutate({ groupId, channelIds: [channelId], granted: true })
              : block.mutate({ groupId, channelIds: [channelId], blocked: true })
          }
        >
          {text.apply}
        </Button>
        <ConfirmAction
          label={text.undo}
          danger={kind === 'grant'}
          disabled={granted === 0 || task.isPending}
          description={`将${kind === 'grant' ? '撤销' : '解除'}「${groupName}」中 ${granted} 个成员对「${channelName}」的${text.undoVerb}，包括单独${text.applyVerb}或经其他用户组${text.applyVerb}的${text.undoVerb}。`}
          action={undo}
          onSuccess={refreshGrants}
        />
      </HStack>
      <ErrorText>{formError(task.error)?.message}</ErrorText>
    </Stack>
  );
}

/** 渠道授权弹窗中的用户组分区。 */
export function ChannelGroupAccess({ channelId, channelName }: { channelId: string; channelName: string }) {
  const groups = useQuery(trpc.admin.groups.channelGroups.queryOptions({ channelId }));
  return (
    <Stack gap="3">
      <Text fontSize="sm" fontWeight="500">
        用户组
      </Text>
      <ErrorText>{formError(groups.error)?.message}</ErrorText>
      {groups.isPending ? (
        <Loading />
      ) : (
        groups.data && (
          <>
            {groups.data.map((group) => (
              <Stack key={group.id} gap="2" borderBottomWidth="1px" borderColor="gray.100" pb="3">
                <Text overflowWrap="anywhere">{group.name}</Text>
                <GroupAccessActions
                  groupId={group.id}
                  groupName={group.name}
                  channelId={channelId}
                  channelName={channelName}
                  granted={group.granted}
                  members={group.memberCount}
                />
              </Stack>
            ))}
            {!groups.data.length && (
              <Text color="gray.500" fontSize="sm">
                暂无用户组
              </Text>
            )}
          </>
        )
      )}
    </Stack>
  );
}
