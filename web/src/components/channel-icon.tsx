import { Box } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { Layers, Plug } from 'lucide-react';

import { channelStatus } from '../lib/channels';
import { ProviderIcon } from './brand-icon';

type Channel = RouterOutputs['admin']['catalog']['list']['channels'][number];

export function StatusDot({ color, ring }: { color: string; ring: string }) {
  return <Box boxSize="2.5" flexShrink="0" borderRadius="full" bg={color} borderWidth="2px" borderColor={ring} />;
}

/** 渠道类型图标，右下角的状态点表示健康状态。 */
export function ChannelIcon({ channel: c, ring = 'white' }: { channel: Channel; ring?: string }) {
  const status = channelStatus(c);
  return (
    <Box
      position="relative"
      color="gray.500"
      display="flex"
      flexShrink="0"
      role="img"
      aria-label={status.label}
      title={status.label}
    >
      {c.subscription ? (
        <ProviderIcon provider={c.subscription.provider} />
      ) : c.type === 'aggregate' ? (
        <Layers size={16} aria-hidden="true" />
      ) : (
        <Plug size={16} aria-hidden="true" />
      )}
      <Box position="absolute" right="-3px" bottom="-3px">
        <StatusDot color={status.color} ring={ring} />
      </Box>
    </Box>
  );
}
