import { Badge, Box, Button, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ErrorText, FormDialog, Loading, Title } from '../components/ui';
import { displayMoney, formError } from '../lib/format';
import { trpc } from '../lib/trpc';

type Model = RouterOutputs['modelPlaza']['models'][number];
type Rule = Model['channels'][number]['rules'][number];
const categories = [
  ['inputPrice', '输入'],
  ['outputPrice', '输出'],
  ['cacheReadPrice', '缓存读取'],
  ['cacheWritePrice', '缓存写入'],
] as const;
const kinds = { default: '默认', context: '上下文', time: '时段', combined: '上下文与时段' };
const minuteText = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

function currencySymbol(currency: string) {
  try {
    return (
      new Intl.NumberFormat('zh-CN', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value ?? currency
    );
  } catch {
    return currency;
  }
}

function Price({ value, symbol }: { value: string | null | undefined; symbol: string }) {
  return (
    <Text as="span" fontFamily="mono" fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
      {value == null ? '—' : `${symbol}${displayMoney(value)}`}
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
  const query = useQuery(trpc.modelPlaza.queryOptions());
  const [selectedId, setSelectedId] = useState<string>();
  const selected = query.data?.models.find((model) => model.id === selectedId);
  const models = query.data?.models ?? [];
  const symbol = currencySymbol(query.data?.currency ?? 'CNY');
  return (
    <Stack gap="6" minW="0">
      <Title>模型广场</Title>
      <Text fontSize="sm" color="gray.500">
        已包含渠道倍率，展示最低价渠道的默认价格；动态定价以实际命中的规则为准。
      </Text>
      <ErrorText>{formError(query.error)?.message}</ErrorText>
      {query.isPending ? (
        <Loading />
      ) : (
        query.data && (
          <Stack gap="3" minW="0">
            {models.length ? (
              <Box borderWidth="1px" borderColor="gray.200" borderRadius="2xl" overflow="hidden" bg="white">
                <Box overflowX="auto">
                  <Table.Root
                    size="md"
                    minW="720px"
                    css={{
                      '& th': { padding: '10px 24px', color: 'gray.500', fontWeight: '500', fontSize: '13px' },
                      '& td': { padding: '10px 24px', borderColor: 'gray.200', verticalAlign: 'middle' },
                      '& tbody tr:last-child td': { borderBottomWidth: '0' },
                    }}
                  >
                    <Table.Caption srOnly>模型定价，输入、输出及缓存价格均按百万 Token 计费</Table.Caption>
                    <Table.Header>
                      <Table.Row bg="gray.50">
                        <Table.ColumnHeader w="40%">模型</Table.ColumnHeader>
                        <Table.ColumnHeader w="35%">价格</Table.ColumnHeader>
                        <Table.ColumnHeader w="25%">缓存</Table.ColumnHeader>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {models.map((model) => {
                        const rules = model.channels[0]?.rules ?? [];
                        const dynamic = rules.some((rule) => rule.kind !== 'default');
                        return (
                          <Table.Row key={model.id} _hover={{ bg: 'gray.50' }}>
                            <Table.Cell minW="220px">
                              <Button
                                variant="plain"
                                h="auto"
                                p="0"
                                maxW="full"
                                fontSize="sm"
                                fontWeight="500"
                                textAlign="start"
                                whiteSpace="normal"
                                overflowWrap="anywhere"
                                aria-label={`查看 ${model.name} 定价详情`}
                                aria-haspopup="dialog"
                                onClick={() => setSelectedId(model.id)}
                                _hover={{ color: '#635bff' }}
                                _focusVisible={{ outline: '2px solid #635bff', outlineOffset: '4px' }}
                              >
                                {model.name}
                              </Button>
                            </Table.Cell>
                            <Table.Cell>
                              <Stack gap="0.5" lineHeight="1.35">
                                <HStack gap="2" fontSize="sm" flexWrap="wrap" aria-label="输入 / 输出价格">
                                  <Price value={model.lowestPrice?.inputPrice} symbol={symbol} />
                                  <Text as="span" color="gray.300" aria-hidden="true">
                                    /
                                  </Text>
                                  <Price value={model.lowestPrice?.outputPrice} symbol={symbol} />
                                </HStack>
                                <HStack gap="2" flexWrap="wrap">
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
                                <Text fontSize="sm" aria-label="缓存读取价格">
                                  <Price value={model.lowestPrice?.cacheReadPrice} symbol={symbol} />
                                </Text>
                                <Text fontSize="xs" color="gray.500">
                                  / 1M tokens
                                </Text>
                              </Stack>
                            </Table.Cell>
                          </Table.Row>
                        );
                      })}
                    </Table.Body>
                  </Table.Root>
                </Box>
              </Box>
            ) : (
              <Text
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="2xl"
                py="12"
                px="6"
                textAlign="center"
                color="gray.500"
                fontSize="sm"
              >
                暂无已定价的可用模型。
              </Text>
            )}
          </Stack>
        )
      )}
      {selected && (
        <FormDialog open title={selected.name} onClose={() => setSelectedId(undefined)} size="xl">
          <Stack gap="6">
            <HStack flexWrap="wrap">
              <Badge colorPalette="gray">输入上限 {selected.inputTokenLimit.toLocaleString()} Token</Badge>
              <Badge colorPalette="gray">输出上限 {selected.outputTokenLimit.toLocaleString()} Token</Badge>
            </HStack>
            {selected.channels.map((channel) => (
              <Stack key={channel.id} gap="3">
                <HStack flexWrap="wrap">
                  <Heading as="h3" fontSize="md" overflowWrap="anywhere">
                    {channel.name}
                  </Heading>
                  <Badge colorPalette="gray">{Number(channel.multiplier)}×</Badge>
                </HStack>
                {channel.rules.length ? (
                  <Box overflowX="auto">
                    <Table.Root size="sm">
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
                              <Table.Cell key={key} whiteSpace="nowrap">
                                <Price value={rule[key]} symbol={symbol} />
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
