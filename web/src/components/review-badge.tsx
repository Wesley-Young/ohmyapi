import { Badge, Box } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';

import { trpc } from '../lib/trpc';

/** 待核对数量轻量轮询，导航与请求页共用同一缓存。 */
export function useReviewCount(enabled: boolean) {
  return useQuery(trpc.admin.reviewCount.queryOptions(undefined, { enabled, refetchInterval: 30_000 })).data ?? 0;
}

const display = (count: number) => (count > 99 ? '99+' : String(count));

/** 数量为 0 时不显示；读屏信息由调用方写入可访问名称。 */
export function ReviewBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <Badge
      colorPalette="red"
      variant="solid"
      borderRadius="full"
      minW="5"
      h="5"
      px="1.5"
      justifyContent="center"
      fontVariantNumeric="tabular-nums"
      aria-hidden="true"
    >
      {display(count)}
    </Badge>
  );
}

/** 侧边栏折叠为图标时使用的角标小红点。 */
export function ReviewDot({ count }: { count: number }) {
  if (!count) return null;
  return (
    <Box
      position="absolute"
      top="-1"
      right="-1"
      boxSize="2.5"
      borderRadius="full"
      bg="red.500"
      borderWidth="2px"
      borderColor="white"
      aria-hidden="true"
    />
  );
}
