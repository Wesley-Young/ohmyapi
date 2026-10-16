import { Badge, Box, Flex, Heading, HStack, Stack, Switch, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ModelIcon } from '../components/brand-icon';
import { IconButton } from '../components/icon-button';
import { emptyModelFilter, ModelFilter } from '../components/model-filter';
import { ErrorText, FormDialog, Loading, NameAction, pinnedColumn, Title } from '../components/ui';
import { useAuth } from '../lib/auth';
import { displayMoney, displayRange, formatCount, formError } from '../lib/format';
import { filterModels, sortModelsByBrand } from '../lib/model-brands';
import { minuteText } from '../lib/pricing';
import { trpc } from '../lib/trpc';

type Model = RouterOutputs['modelPlaza']['models'][number];
type Rule = Model['channels'][number]['rules'][number];
const categories = [
  ['inputPrice', '输入'],
  ['outputPrice', '输出'],
  ['cacheReadPrice', '缓存读取'],
  ['cacheWritePrice', '缓存写入'],
  ['webSearchPrice', '搜索 / 千次'],
  ['webSearchPreviewPrice', '预览搜索 / 千次'],
] as const;

function currencySymbol(currency: string) {
  try {
    return (
      new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value ?? currency
    );
  } catch {
    return currency;
  }
}

function Price({
  value,
  maximum,
  symbol,
}: {
  value: string | null | undefined;
  maximum?: string | null;
  symbol: string;
}) {
  return (
    <Text as="span" fontFamily="mono" fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
      {value == null ? '—' : `${symbol}${maximum == null ? displayMoney(value) : displayRange(value, maximum)}`}
    </Text>
  );
}

function RuleConditions({ rule }: { rule: Rule }) {
  return (
    <Stack gap="1">
      <HStack flexWrap="wrap">
        <Text fontWeight="500">{rule.label}</Text>
      </HStack>
      {rule.contextMin !== null && (
        <Text fontSize="xs" color="gray.500">
          上下文 [{rule.contextMin}, {rule.contextMax ?? '∞'}) Token
        </Text>
      )}
      {rule.weekdaysMask !== null && (
        <Text fontSize="xs" color="gray.500">
          {['一', '二', '三', '四', '五', '六', '日']
            .filter((_, i) => (rule.weekdaysMask ?? 0) & (1 << i))
            .map((day) => `周${day}`)
            .join('、')}{' '}
          {minuteText(rule.startMinute ?? 0)}–{minuteText(rule.endMinute ?? 0)}（上海时间）
        </Text>
      )}
    </Stack>
  );
}

export default function ModelPlaza() {
  const { data: user } = useAuth();
  const admin = user?.role === 'admin';
  const query = useQuery(trpc.modelPlaza.queryOptions());
  const [selectedId, setSelectedId] = useState<string>();
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
  const selected = available.find((model) => model.id === selectedId);
  const symbol = currencySymbol(query.data?.currency ?? 'CNY');
  return (
    <Stack gap="7" minW="0">
      <Title>模型广场</Title>
      <Text fontSize="sm" color="gray.500">
        已包含渠道倍率，展示默认规则下的最低配置价格；透传倍率按实际路由成员计费，动态定价以实际命中的规则为准。
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
        (models.length ? (
          <Box overflowX="auto">
            <Table.Root size="sm" whiteSpace="nowrap">
              <Table.Caption srOnly>模型定价，输入、输出及缓存价格均按百万 Token 计费</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>模型</Table.ColumnHeader>
                  <Table.ColumnHeader>输入 / 输出</Table.ColumnHeader>
                  <Table.ColumnHeader>缓存读取 / 缓存写入</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end" {...pinnedColumn}>
                    操作
                  </Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {models.map((model) => {
                  const rules = model.channels[0]?.rules ?? [];
                  const dynamic = rules.some((rule) => rule.kind !== 'default');
                  return (
                    <Table.Row key={model.id}>
                      <Table.Cell minW="220px">
                        <NameAction aria-haspopup="dialog" onClick={() => setSelectedId(model.id)}>
                          <ModelIcon model={model.name} />
                          {model.name}
                        </NameAction>
                      </Table.Cell>
                      <Table.Cell>
                        <Stack gap="0.5" lineHeight="1.35">
                          <HStack gap="2" fontSize="sm" aria-label="输入 / 输出价格">
                            <Price value={model.lowestPrice?.inputPrice} symbol={symbol} />
                            <Text as="span" color="gray.300" aria-hidden="true">
                              /
                            </Text>
                            <Price value={model.lowestPrice?.outputPrice} symbol={symbol} />
                          </HStack>
                          <HStack gap="2">
                            <Text fontSize="xs" color="gray.500">
                              / 1M tokens
                            </Text>
                            {dynamic && (
                              <Badge colorPalette="blue" size="sm">
                                动态计费
                              </Badge>
                            )}
                          </HStack>
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
                        <Stack gap="0.5" lineHeight="1.35">
                          <HStack gap="2" fontSize="sm" aria-label="缓存读取 / 写入价格">
                            <Price value={model.lowestPrice?.cacheReadPrice} symbol={symbol} />
                            <Text as="span" color="gray.300" aria-hidden="true">
                              /
                            </Text>
                            <Price value={model.lowestPrice?.cacheWritePrice} symbol={symbol} />
                          </HStack>
                          <Text fontSize="xs" color="gray.500">
                            / 1M tokens
                          </Text>
                        </Stack>
                      </Table.Cell>
                      <Table.Cell textAlign="end" {...pinnedColumn}>
                        <IconButton
                          aria-label={`查看「${model.name}」定价详情`}
                          title="查看详情"
                          aria-haspopup="dialog"
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedId(model.id)}
                        >
                          <Eye size={16} aria-hidden="true" />
                        </IconButton>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </Box>
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
      {selected && (
        <FormDialog open title={selected.name} onClose={() => setSelectedId(undefined)} size="xl">
          <Stack gap="6">
            <HStack flexWrap="wrap">
              <Badge colorPalette="gray">输入上限 {formatCount(selected.inputTokenLimit)} Token</Badge>
              <Badge colorPalette="gray">输出上限 {formatCount(selected.outputTokenLimit)} Token</Badge>
            </HStack>
            {selected.channels.map((channel) => (
              <Stack key={channel.id} gap="3">
                <HStack flexWrap="wrap">
                  <Heading as="h3" fontSize="md" overflowWrap="anywhere">
                    {channel.name}
                  </Heading>
                  <Badge colorPalette="gray">{displayRange(channel.multiplier, channel.maxMultiplier)}×</Badge>
                  {channel.pricingMode === 'passthrough' && <Badge colorPalette="gray">透传倍率</Badge>}
                </HStack>
                {channel.pricingMode === 'passthrough' && (
                  <Text fontSize="sm" color="gray.500">
                    显示全部成员的配置价格区间，实际价格取决于路由成员。
                  </Text>
                )}
                {channel.rules.length ? (
                  <Box overflowX="auto">
                    <Table.Root size="sm" whiteSpace="nowrap">
                      <Table.Header>
                        <Table.Row>
                          <Table.ColumnHeader>规则</Table.ColumnHeader>
                          {categories.map(([key, label]) => (
                            <Table.ColumnHeader key={key}>{label}</Table.ColumnHeader>
                          ))}
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {channel.rules.map((rule) => (
                          <Table.Row key={rule.id}>
                            <Table.Cell minW="180px">
                              <RuleConditions rule={rule} />
                            </Table.Cell>
                            {categories.map(([key]) => (
                              <Table.Cell key={key}>
                                <Price value={rule[key]} maximum={rule.maximum[key]} symbol={symbol} />
                              </Table.Cell>
                            ))}
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Root>
                  </Box>
                ) : (
                  <Text fontSize="sm" color="gray.500">
                    尚未配置价格
                  </Text>
                )}
              </Stack>
            ))}
          </Stack>
        </FormDialog>
      )}
    </Stack>
  );
}
