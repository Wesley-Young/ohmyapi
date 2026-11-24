import { Badge, Box, Button, Grid, Heading, HStack, NativeSelect, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useState } from 'react';

import { endpointProtocolNames } from '../lib/endpoints';
import { displayMultiplier } from '../lib/format';
import { PlazaPriceRow, PlazaPriceTable, PlazaRules } from './plaza-pricing';

type Model = RouterOutputs['modelPlaza']['models'][number];
type Offer = Model['channels'][number];
type Channel = Pick<Offer, 'id' | 'name' | 'multiplier' | 'maxMultiplier'> & {
  entries: { model: Model; offer: Offer }[];
};

function groupByChannel(models: Model[]) {
  const channels = new Map<string, Channel>();
  for (const model of models) {
    for (const offer of model.channels) {
      let channel = channels.get(offer.id);
      if (!channel) {
        channel = {
          id: offer.id,
          name: offer.name,
          multiplier: offer.multiplier,
          maxMultiplier: offer.maxMultiplier,
          entries: [],
        };
        channels.set(offer.id, channel);
      } else {
        if (Number(offer.multiplier) < Number(channel.multiplier)) channel.multiplier = offer.multiplier;
        if (Number(offer.maxMultiplier) > Number(channel.maxMultiplier)) channel.maxMultiplier = offer.maxMultiplier;
      }
      channel.entries.push({ model, offer });
    }
  }
  return [...channels.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
}

function ChannelPrices({ channel, symbol }: { channel: Channel; symbol: string }) {
  return (
    <PlazaPriceTable>
      {channel.entries.map(({ model, offer }) => {
        const rule = offer.rules.find((item) => item.kind === 'default');
        return (
          <PlazaPriceRow
            key={model.id}
            model={model}
            rule={rule}
            maximum={rule?.maximum}
            symbol={symbol}
            dynamic={offer.rules.some((item) => item.kind !== 'default')}
          >
            <Stack gap="3">
              <HStack flexWrap="wrap">
                <Badge>倍率 {displayMultiplier(offer.multiplier, offer.maxMultiplier)}</Badge>
                {offer.endpoints.map((endpoint) => (
                  <Badge key={endpoint}>{endpointProtocolNames[endpoint]}</Badge>
                ))}
              </HStack>
              <PlazaRules rules={offer.rules} symbol={symbol} />
            </Stack>
          </PlazaPriceRow>
        );
      })}
    </PlazaPriceTable>
  );
}

export function PlazaChannels({ models, symbol }: { models: Model[]; symbol: string }) {
  const channels = groupByChannel(models);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = channels.find((channel) => channel.id === selectedId) ?? channels[0];
  if (!selected)
    return (
      <Text color="gray.500" fontSize="sm">
        暂无可用渠道。
      </Text>
    );
  return (
    <Grid
      templateColumns={{ base: 'minmax(0, 1fr)', lg: '240px minmax(0, 1fr)' }}
      gap={{ base: '5', md: '7' }}
      alignItems="start"
    >
      <Stack
        as="section"
        aria-label="渠道目录"
        gap="3"
        minW="0"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="xl"
        p="2"
      >
        <Heading as="h2" size="sm" px="3" pt="1">
          可用渠道{' '}
          <Text as="span" color="gray.500" fontWeight="400">
            ({channels.length})
          </Text>
        </Heading>
        <NativeSelect.Root hideFrom="lg" size="sm">
          <NativeSelect.Field
            aria-label="选择渠道"
            value={selected.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name}（{displayMultiplier(channel.multiplier, channel.maxMultiplier)}）
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
        <Stack hideBelow="lg" gap="1">
          {channels.map((channel) => (
            <Button
              key={channel.id}
              variant="ghost"
              size="sm"
              justifyContent="space-between"
              h="auto"
              minH="10"
              py="2"
              whiteSpace="normal"
              textAlign="start"
              aria-pressed={channel.id === selected.id}
              _pressed={{ bg: 'gray.100' }}
              bg={channel.id === selected.id ? 'gray.100' : undefined}
              onClick={() => setSelectedId(channel.id)}
            >
              <Text as="span" overflowWrap="anywhere">
                {channel.name}
              </Text>
              <Text as="span" color="gray.600" fontVariantNumeric="tabular-nums" textAlign="end">
                {displayMultiplier(channel.multiplier, channel.maxMultiplier)}
              </Text>
            </Button>
          ))}
        </Stack>
      </Stack>
      <Box minW="0" borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={{ base: '5', md: '6' }}>
        <ChannelPrices key={selected.id} channel={selected} symbol={symbol} />
      </Box>
    </Grid>
  );
}
