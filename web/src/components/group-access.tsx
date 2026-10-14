import { Badge, Button, HStack, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { refreshGrants } from '../lib/cache';
import { formError } from '../lib/format';
import { trpc, trpcClient } from '../lib/trpc';
import { ConfirmAction, ErrorText, Loading } from './ui';

/** 为组的当前成员一次性授予或撤销某个渠道；不改变组本身。 */
export function GroupAccessActions({
  groupId,
  groupName,
  channelId,
  channelName,
  granted,
  members,
}: {
  groupId: string;
  groupName: string;
  channelId: string;
  channelName: string;
  granted: number;
  members: number;
}) {
  const task = useMutation(trpc.admin.groups.setChannelAccess.mutationOptions({ onSuccess: refreshGrants }));
  return (
    <Stack gap="2" align="start">
      <HStack gap="2" flexWrap="wrap">
        <Badge colorPalette={members > 0 && granted === members ? 'green' : 'gray'}>
          已授权 {granted}/{members}
        </Badge>
        <Button
          size="sm"
          variant="outline"
          aria-label={`为「${groupName}」全部成员授予「${channelName}」`}
          disabled={granted >= members}
          loading={task.isPending}
          onClick={() => task.mutate({ groupId, channelIds: [channelId], granted: true })}
        >
          授予全部
        </Button>
        <ConfirmAction
          label="撤销全部"
          danger
          disabled={granted === 0 || task.isPending}
          description={`将撤销「${groupName}」中 ${granted} 个成员对「${channelName}」的授权，包括单独授予或经其他用户组授予的授权。`}
          action={() =>
            trpcClient.admin.groups.setChannelAccess.mutate({ groupId, channelIds: [channelId], granted: false })
          }
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
