import { Box, Button, Checkbox, Field, Grid, HStack, Input, Stack, Text } from '@chakra-ui/react';
import { useState } from 'react';

import { brandColor } from '../lib/theme';
import { ModelLabel } from './brand-icon';
import {
  type CatalogModel,
  type ChannelModel,
  channelModel,
  effectiveUpstream,
  ModelStatus,
  modelNameError,
  validModelName,
} from './channel-models';
import { ErrorText } from './ui';

export type FetchedModels = { names: string[]; ignored: number; unavailable?: number };

type Entry = { checked: boolean; name: string };

const rowColumns = { base: 'auto minmax(0, 1fr)', sm: 'auto minmax(0, 1fr) minmax(0, 1fr)' };
const rowAreas = { base: `"check upstream" ". target"`, sm: `"check upstream target"` };

/**
 * 从上游拉取的模型：上游名称固定，逐个选择是否加入并设置对外名称（默认与上游名称相同）。
 * 已有模型按实际发往上游的名称判断，已添加的上游模型不能重复选择。
 */
export function UpstreamImport({
  result,
  rows,
  models,
  disabled,
  onAdd,
  onCancel,
}: {
  result: FetchedModels;
  rows: ChannelModel[];
  models: CatalogModel[];
  disabled: boolean;
  onAdd: (rows: ChannelModel[]) => void;
  onCancel: () => void;
}) {
  const covered = new Map<string, string[]>();
  for (const row of rows) {
    const upstream = effectiveUpstream(row);
    covered.set(upstream, [...(covered.get(upstream) ?? []), row.name.trim()]);
  }
  // 默认勾选打开时尚未添加的上游模型。
  const [entries, setEntries] = useState(
    () =>
      new Map<string, Entry>(
        result.names.filter((name) => !covered.has(name)).map((name) => [name, { checked: true, name }]),
      ),
  );
  const [search, setSearch] = useState('');
  const entry = (upstream: string) => entries.get(upstream) ?? { checked: false, name: upstream };
  const update = (upstream: string, change: Partial<Entry>) =>
    setEntries((current) => new Map(current).set(upstream, { ...entry(upstream), ...change }));

  const fresh = result.names.filter((name) => !covered.has(name));
  const selected = fresh.filter((name) => entry(name).checked);
  const existingNames = new Set(rows.map((row) => row.name.trim()));
  const counts = new Map<string, number>();
  for (const upstream of selected) {
    const name = entry(upstream).name.trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const errorOf = (upstream: string) => {
    if (covered.has(upstream) || !entry(upstream).checked) return undefined;
    const name = entry(upstream).name.trim();
    if (!name) return '请输入对外名称';
    if (!validModelName(name)) return modelNameError;
    if (existingNames.has(name)) return '与已添加的模型重名';
    if ((counts.get(name) ?? 0) > 1) return '对外名称重复';
  };
  const invalid = selected.some((upstream) => errorOf(upstream));
  const overLimit = rows.length + selected.length > 1000;

  const term = search.trim().toLowerCase();
  const visible = [...fresh, ...result.names.filter((name) => covered.has(name))].filter(
    (upstream) => !term || `${upstream} ${entry(upstream).name}`.toLowerCase().includes(term),
  );
  const visibleFresh = visible.filter((name) => !covered.has(name));
  const selectVisible = (checked: boolean) =>
    setEntries((current) => {
      const next = new Map(current);
      for (const upstream of visibleFresh) next.set(upstream, { ...entry(upstream), checked });
      return next;
    });

  return (
    <Stack
      role="region"
      aria-label="导入上游模型"
      gap="3"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      p="4"
    >
      <Stack gap="1">
        <Text fontSize="sm" fontWeight="500">
          导入上游模型
        </Text>
        <Text fontSize="xs" color="gray.500">
          上游返回 {result.names.length} 个模型，{fresh.length} 个未添加
          {result.ignored ? `，忽略 ${result.ignored} 个无效条目` : ''}
          {result.unavailable ? `，跳过 ${result.unavailable} 个不可选模型` : ''}。<b>对外名称决定计费使用的模型。</b>
        </Text>
      </Stack>
      <HStack gap="2" flexWrap="wrap">
        <Input
          aria-label="筛选上游模型"
          value={search}
          placeholder="筛选"
          size="sm"
          maxW={{ base: 'full', sm: '240px' }}
          borderRadius="lg"
          focusRingColor={brandColor}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || !visibleFresh.length}
          onClick={() => selectVisible(true)}
        >
          全选
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || !visibleFresh.length}
          onClick={() => selectVisible(false)}
        >
          全不选
        </Button>
      </HStack>
      <Box maxH="360px" overflowY="auto" borderTopWidth="1px" borderColor="gray.100" pt="3">
        <Grid
          templateColumns={rowColumns}
          columnGap="3"
          mb="2"
          display={{ base: 'none', sm: 'grid' }}
          fontSize="xs"
          color="gray.500"
          aria-hidden="true"
        >
          <Box w="4" />
          <Text>上游模型</Text>
          <Text>导入为（对外名称）</Text>
        </Grid>
        {visible.map((upstream) => {
          const added = covered.get(upstream);
          const { checked, name } = entry(upstream);
          const error = errorOf(upstream);
          return (
            <Grid
              key={upstream}
              templateColumns={rowColumns}
              templateAreas={rowAreas}
              columnGap="3"
              rowGap="2"
              alignItems="center"
              py="2"
            >
              <Checkbox.Root
                gridArea="check"
                checked={!added && checked}
                disabled={disabled || Boolean(added)}
                onCheckedChange={(event) => update(upstream, { checked: event.checked === true })}
              >
                <Checkbox.HiddenInput aria-label={`导入 ${upstream}`} />
                <Checkbox.Control />
              </Checkbox.Root>
              <Text gridArea="upstream" fontSize="sm" minW="0" overflowWrap="anywhere">
                <ModelLabel model={upstream} />
              </Text>
              {added ? (
                <Text gridArea="target" fontSize="sm" color="gray.500" overflowWrap="anywhere">
                  已添加为 {added.join('、')}
                </Text>
              ) : (
                <Field.Root gridArea="target" invalid={Boolean(error)} minW="0">
                  <Input
                    aria-label={`${upstream} 的对外名称`}
                    value={name}
                    size="sm"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={128}
                    disabled={disabled || !checked}
                    onChange={(event) => update(upstream, { name: event.target.value })}
                    borderRadius="lg"
                    focusRingColor={brandColor}
                  />
                  {error ? (
                    <Field.ErrorText>{error}</Field.ErrorText>
                  ) : (
                    checked &&
                    name.trim() && (
                      <HStack gap="1.5" flexWrap="wrap" _empty={{ display: 'none' }}>
                        <ModelStatus name={name.trim()} models={models} />
                      </HStack>
                    )
                  )}
                </Field.Root>
              )}
            </Grid>
          );
        })}
        {!visible.length && (
          <Text py="4" textAlign="center" fontSize="sm" color="gray.500">
            没有匹配的模型
          </Text>
        )}
      </Box>
      <ErrorText>{overLimit ? '合并后超过 1000 个模型，请减少选择或先移除部分模型' : undefined}</ErrorText>
      <HStack gap="2" flexWrap="wrap">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !selected.length || invalid || overLimit}
          onClick={() =>
            onAdd(
              selected.map((upstream) => {
                const name = entry(upstream).name.trim();
                return channelModel(name, name === upstream ? null : upstream);
              }),
            )
          }
        >
          加入 {selected.length} 个模型
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
          取消
        </Button>
      </HStack>
    </Stack>
  );
}
