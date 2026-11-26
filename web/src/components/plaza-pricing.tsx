import { Accordion, Badge, Box, Grid, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import type { ReactNode } from 'react';

import { displayMoney, displayRange } from '../lib/format';
import { minuteText } from '../lib/pricing';
import { ModelLabel } from './brand-icon';

type Model = RouterOutputs['modelPlaza']['models'][number];
type Rule = Model['channels'][number]['rules'][number];
const categories = [
  ['imagePrice', '图像 / 张'],
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

const priceColumns = {
  text: 'minmax(0, 1.2fr) repeat(2, minmax(0, 1fr)) 1rem',
  image: 'minmax(0, 1.2fr) minmax(0, 1fr) 1rem',
} satisfies Record<Model['outputKind'], string>;

export function PlazaPriceTables<T>({
  entries,
  outputKind,
  children,
}: {
  entries: T[];
  outputKind: (entry: T) => Model['outputKind'];
  children: (entry: T) => ReactNode;
}) {
  return (
    <Stack gap="6" minW="0">
      {(['text', 'image'] as const).map((kind) => {
        const rows = entries.filter((entry) => outputKind(entry) === kind);
        if (!rows.length) return null;
        const title = kind === 'text' ? '文本模型' : '图像模型';
        return (
          <Stack key={kind} as="section" aria-label={title} gap="2" minW="0">
            <Heading as="h2" size="sm">
              {title}
            </Heading>
            <Accordion.Root collapsible lazyMount unmountOnExit minW="0">
              <Grid
                hideBelow="md"
                templateColumns={priceColumns[kind]}
                gap="3"
                px="3"
                py="2"
                borderBottomWidth={1}
                fontSize="xs"
                color="gray.600"
              >
                <Text>模型</Text>
                <Text>{kind === 'text' ? '输入 / 输出' : '每张单价'}</Text>
                {kind === 'text' && <Text>缓存读取 / 缓存写入</Text>}
              </Grid>
              {rows.map(children)}
            </Accordion.Root>
          </Stack>
        );
      })}
    </Stack>
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
        gridTemplateColumns={{ base: 'minmax(0, 1fr) 1rem', md: priceColumns[model.outputKind] }}
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
        {model.outputKind === 'image' && (
          <HStack
            as="span"
            gridColumn={{ base: '1 / -1', md: 'auto' }}
            fontSize="sm"
            minW="0"
            flexWrap="wrap"
            overflowWrap="anywhere"
          >
            <Text as="span">
              <Price value={rule?.imagePrice} maximum={maximum?.imagePrice} symbol={symbol} /> / 张
            </Text>
            {dynamic && (
              <Badge size="sm" colorPalette="blue">
                动态计费
              </Badge>
            )}
          </HStack>
        )}
        {model.outputKind === 'text' &&
          (['tokens', 'cache'] as const).map((kind) => (
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

export function PlazaRules({
  rules,
  symbol,
  outputKind,
}: {
  rules: Rule[];
  symbol: string;
  outputKind: Model['outputKind'];
}) {
  const visibleCategories = categories.filter(([key]) => (key === 'imagePrice') === (outputKind === 'image'));
  return rules.length ? (
    <Box overflowX="auto">
      <Table.Root size="sm" whiteSpace="nowrap">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>规则</Table.ColumnHeader>
            {visibleCategories.map(([key, label]) => (
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
              {visibleCategories.map(([key]) => (
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
