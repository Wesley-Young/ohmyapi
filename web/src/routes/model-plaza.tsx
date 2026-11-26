import { Badge, Flex, Heading, HStack, Stack, Switch, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { ChannelVendorIcon } from '../components/brand-icon';
import { emptyModelFilter, ModelFilter } from '../components/model-filter';
import { PlazaChannels } from '../components/plaza-channels';
import { PlazaPriceRow, PlazaPriceTables, PlazaRules } from '../components/plaza-pricing';
import { ErrorText, Loading, Title } from '../components/ui';
import { ViewSwitch } from '../components/view-switch';
import { useAuth } from '../lib/auth';
import { endpointProtocolNames } from '../lib/endpoints';
import { currencySymbol, displayMultiplier, formatCount, formError } from '../lib/format';
import { channelVendors, filterModels, sortModelsByBrand } from '../lib/model-brands';
import { trpc } from '../lib/trpc';

const views = [
  { value: 'models', label: '按模型' },
  { value: 'channels', label: '按渠道' },
] as const;

export default function ModelPlaza() {
  const { data: user } = useAuth();
  const admin = user?.role === 'admin';
  const query = useQuery(trpc.modelPlaza.queryOptions());
  const vendors = useQuery(trpc.keys.channels.queryOptions(undefined, { select: channelVendors }));
  const [view, setView] = useState<(typeof views)[number]['value']>('models');
  const [publicOnly, setPublicOnly] = useState(false);
  const [filter, setFilter] = useState(emptyModelFilter);
  const all = useMemo(() => sortModelsByBrand(query.data?.models ?? []), [query.data]);
  const available = useMemo(() => {
    if (!admin || !publicOnly) return all;
    return all.flatMap((model) => {
      // 渠道已按倍率升序排列，首个公开渠道即公开售价的最低配置
      const channels = model.channels.filter((channel) => channel.isPublic);
      const [lowest] = channels;
      if (!lowest) return [];
      return [
        {
          ...model,
          channels,
          lowestPriceVariable: lowest.pricingMode === 'passthrough',
          lowestPrice: lowest.rules.find((rule) => rule.kind === 'default') ?? null,
        },
      ];
    });
  }, [all, admin, publicOnly]);
  const models = filterModels(available, filter);
  const symbol = currencySymbol(query.data?.currency ?? 'CNY');
  return (
    <Stack gap="7" minW="0">
      <Title action={<ViewSwitch label="浏览方式" items={views} value={view} onChange={setView} />}>模型广场</Title>
      <Text fontSize="sm" color="gray.500">
        {view === 'models'
          ? '展示默认规则下的最低配置价格，已包含渠道倍率。实际价格以命中的计费规则和倍率为准。'
          : '展示所选渠道的默认价格，已包含渠道倍率。'}
      </Text>
      {(admin || all.length > 0) && (
        <Flex gap="4" direction={{ base: 'column', md: 'row' }}>
          {all.length > 0 && <ModelFilter models={all} value={filter} onChange={setFilter} flex="1" maxW="lg" />}
          {admin && (
            <Switch.Root
              size="sm"
              colorPalette="purple"
              checked={publicOnly}
              onCheckedChange={(e) => setPublicOnly(e.checked)}
              alignSelf={{ base: 'flex-start', md: 'center' }}
              flexShrink="0"
              ms={{ md: 'auto' }}
            >
              <Switch.HiddenInput />
              <Switch.Control />
              <Switch.Label>只展示公开渠道</Switch.Label>
            </Switch.Root>
          )}
        </Flex>
      )}
      <ErrorText>{formError(query.error)?.message}</ErrorText>
      {query.isPending ? (
        <Loading />
      ) : (
        query.data &&
        (models.length && view === 'channels' ? (
          <PlazaChannels models={models} symbol={symbol} vendors={vendors.data} />
        ) : models.length ? (
          <PlazaPriceTables entries={models} outputKind={(model) => model.outputKind}>
            {(model) => (
              <PlazaPriceRow
                key={model.id}
                model={model}
                rule={model.lowestPrice}
                symbol={symbol}
                dynamic={model.channels[0]?.rules.some((rule) => rule.kind !== 'default')}
              >
                <Stack gap="6">
                  {model.outputKind === 'text' && model.inputTokenLimit !== null && model.outputTokenLimit !== null && (
                    <HStack flexWrap="wrap">
                      <Badge colorPalette="gray">输入上限 {formatCount(model.inputTokenLimit)} Token</Badge>
                      <Badge colorPalette="gray">输出上限 {formatCount(model.outputTokenLimit)} Token</Badge>
                    </HStack>
                  )}
                  {model.channels.map((channel) => (
                    <Stack key={channel.id} gap="3">
                      <HStack flexWrap="wrap">
                        <HStack gap="2" minW="0">
                          <ChannelVendorIcon vendor={vendors.data?.get(channel.id)} />
                          <Heading as="h3" fontSize="md" overflowWrap="anywhere">
                            {channel.name}
                          </Heading>
                        </HStack>
                        {channel.endpoints.includes('/v1/images') && (
                          <Badge>{endpointProtocolNames['/v1/images']}</Badge>
                        )}
                        <Badge colorPalette="gray">
                          {displayMultiplier(channel.multiplier, channel.maxMultiplier)}
                        </Badge>
                      </HStack>
                      {channel.multiplier !== channel.maxMultiplier && (
                        <Text fontSize="sm" color="gray.500">
                          价格区间已包含渠道倍率，实际价格取决于本次请求的适用倍率。
                        </Text>
                      )}
                      <PlazaRules outputKind={model.outputKind} rules={channel.rules} symbol={symbol} />
                    </Stack>
                  ))}
                </Stack>
              </PlazaPriceRow>
            )}
          </PlazaPriceTables>
        ) : (
          <Text py="8" color="gray.500" fontSize="sm">
            {available.length
              ? '没有匹配的模型。'
              : admin && publicOnly
                ? '公开渠道暂无已定价的可用模型。'
                : '暂无已定价的可用模型。'}
          </Text>
        ))
      )}
    </Stack>
  );
}
