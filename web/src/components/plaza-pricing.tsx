import { Accordion, Badge, Box, Grid, HStack, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import type { ReactNode } from 'react';

import { displayMoney, displayRange } from '../lib/format';
import { minuteText } from '../lib/pricing';
import { ModelLabel } from './brand-icon';

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
    <Text as="span" fontFamily="mono" fontVariantNumeric="tabular-nums">
      {value == null ? '—' : `${symbol}${maximum == null ? displayMoney(value) : displayRange(value, maximum)}`}
    </Text>
  );
}

function PricePair({
  kind,
  rule,
  maximum,
  symbol,
}: {
  kind: 'tokens' | 'cache';
  rule?: Rule | null;
  maximum?: Rule['maximum'];
  symbol: string;
}) {
  const [first, second] =
    kind === 'tokens' ? (['inputPrice', 'outputPrice'] as const) : (['cacheReadPrice', 'cacheWritePrice'] as const);
  return (
    <HStack
      as="span"
      gap="2"
      fontSize="sm"
      flexWrap="wrap"
      rowGap="0"
      overflowWrap="anywhere"
      aria-label={kind === 'tokens' ? '输入 / 输出价格' : '缓存读取 / 缓存写入价格'}
    >
      <Price value={rule?.[first]} maximum={maximum?.[first]} symbol={symbol} />
      <Text as="span" color="gray.300" aria-hidden="true">
        /
      </Text>
      <Price value={rule?.[second]} maximum={maximum?.[second]} symbol={symbol} />
    </HStack>
  );
}

const priceColumns = 'minmax(0, 1.2fr) repeat(2, minmax(0, 1fr)) 1rem';

export function PlazaPriceTable({ children }: { children: ReactNode }) {
  return (
    <Accordion.Root collapsible lazyMount unmountOnExit minW="0">
      <Grid
        hideBelow="md"
        templateColumns={priceColumns}
        gap="3"
        px="3"
        py="2"
        borderBottomWidth={1}
        fontSize="xs"
        color="gray.600"
      >
        <Text>模型</Text>
        <Text>输入 / 输出</Text>
        <Text>缓存读取 / 缓存写入</Text>
      </Grid>
      {children}
    </Accordion.Root>
  );
}

export function PlazaPriceRow({
  model,
  rule,
  maximum,
  symbol,
  dynamic,
  children,
}: {
  model: Model;
  rule: Rule | null | undefined;
  maximum?: Rule['maximum'];
  symbol: string;
  dynamic?: boolean;
  children: ReactNode;
}) {
  return (
    <Accordion.Item value={model.id}>
      <Accordion.ItemTrigger
        display="grid"
        gridTemplateColumns={{ base: 'minmax(0, 1fr) 1rem', md: priceColumns }}
        gap="3"
        px="3"
        _hover={{ bg: 'gray.50' }}
      >
        <ModelLabel
          model={model.name}
          size={14}
          fontSize="sm"
          gridColumn={{ base: '1', md: 'auto' }}
          overflowWrap="anywhere"
        />
        {(['tokens', 'cache'] as const).map((kind) => (
          <HStack key={kind} as="span" minW="0" alignItems="center" gridColumn={{ base: '1 / -1', md: 'auto' }}>
            <Text as="span" hideFrom="md" fontSize="xs" color="gray.600">
              {kind === 'tokens' ? '输入 / 输出' : '缓存读取 / 缓存写入'}
            </Text>
            <PricePair kind={kind} rule={rule} maximum={maximum} symbol={symbol} />
            {dynamic && kind === 'tokens' && (
              <Badge size="sm" colorPalette="blue">
                动态计费
              </Badge>
            )}
          </HStack>
        ))}
        <Accordion.ItemIndicator gridColumn="-2" gridRow="1" />
      </Accordion.ItemTrigger>
      <Accordion.ItemContent>
        <Accordion.ItemBody px="3" minW="0">
          {children}
        </Accordion.ItemBody>
      </Accordion.ItemContent>
    </Accordion.Item>
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

export function PlazaRules({ rules, symbol }: { rules: Rule[]; symbol: string }) {
  return rules.length ? (
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
          {rules.map((rule) => (
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
  );
}
