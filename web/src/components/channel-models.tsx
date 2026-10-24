import { Badge, Box, Button, Field, Grid, HStack, Input, InputGroup, Stack, Text, Textarea } from '@chakra-ui/react';
import type { RouterInputs, RouterOutputs } from '@ohmyapi/daemon/trpc';
import { Download, Plus, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

import { modelBrand } from '../lib/model-brands';
import { brandColor } from '../lib/theme';
import { ModelIcon, ModelLabel } from './brand-icon';
import { IconButton } from './icon-button';
import { ErrorText } from './ui';

type ChannelModelInput = NonNullable<RouterInputs['admin']['catalog']['saveChannel']['availableModels']>[number];
/** 渠道弹窗中的一行模型；key 只在界面中区分行，对外名称可以修改。 */
export type ChannelModel = ChannelModelInput & { key: string };
export type CatalogModel = RouterOutputs['admin']['catalog']['list']['models'][number];

let nextKey = 0;
export const channelModel = (name: string, upstreamModel: string | null = null): ChannelModel => ({
  key: `model-${nextKey++}`,
  name,
  multiplier: null,
  upstreamModel,
});

const modelNamePattern = /^[A-Za-z0-9][A-Za-z0-9_./:-]*$/;
export const validModelName = (name: string) => name.length <= 128 && modelNamePattern.test(name);
export const modelNameError = '需为 1–128 个字符，仅支持字母、数字和 _ . / : -';

/** 实际发往上游的模型名。 */
export const effectiveUpstream = (model: ChannelModel) => model.upstreamModel?.trim() || model.name.trim();

/** 提交给服务端的模型列表；上游模型名留空表示与对外名称相同。 */
export const channelModelsInput = (rows: ChannelModel[]): ChannelModelInput[] =>
  rows.map((row) => ({
    name: row.name.trim(),
    multiplier: row.multiplier,
    upstreamModel: row.upstreamModel?.trim() || null,
  }));

type RowErrors = { name?: string; upstream?: string };

export function channelModelErrors(rows: ChannelModel[]) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.name.trim(), (counts.get(row.name.trim()) ?? 0) + 1);
  const errors = new Map<string, RowErrors>();
  for (const row of rows) {
    const name = row.name.trim();
    const upstream = row.upstreamModel?.trim() ?? '';
    const error: RowErrors = {};
    if (!name) error.name = '请输入对外名称';
    else if (!validModelName(name)) error.name = modelNameError;
    else if ((counts.get(name) ?? 0) > 1) error.name = '对外名称重复';
    if (upstream && !validModelName(upstream)) error.upstream = modelNameError;
    if (error.name || error.upstream) errors.set(row.key, error);
  }
  return errors;
}

/** 对外名称对应的目录模型状态；对外名称决定计费使用的模型。 */
export function ModelStatus({ name, models }: { name: string; models: CatalogModel[] }) {
  const existing = models.find((item) => item.name === name);
  if (!existing) return <Badge colorPalette="gray">待创建</Badge>;
  return (
    <>
      {!existing.priced && <Badge colorPalette="gray">未定价</Badge>}
      {!existing.enabled && <Badge colorPalette="gray">已禁用</Badge>}
    </>
  );
}

function MultiplierField({
  model,
  onChange,
  disabled,
}: {
  model: ChannelModel;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <Field.Root
      display="grid"
      minW="0"
      gridTemplateColumns={{ base: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) 170px' }}
      gap="3"
      alignItems="center"
    >
      <Field.Label htmlFor={id} fontSize="sm" minW="0" overflowWrap="anywhere">
        <ModelLabel model={model.name} />
      </Field.Label>
      <Input
        id={id}
        aria-label={`${model.name} 专属倍率`}
        value={model.multiplier ?? ''}
        inputMode="decimal"
        placeholder="继承整体倍率"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
        borderRadius="lg"
        focusRingColor={brandColor}
      />
    </Field.Root>
  );
}

const rowColumns = { base: 'minmax(0, 1fr) auto', sm: 'minmax(0, 1fr) minmax(0, 1fr) 120px auto' };
const rowAreas = {
  base: `"name remove" "upstream upstream" "multiplier multiplier"`,
  sm: `"name upstream multiplier remove"`,
};

function ModelRow({
  row,
  models,
  errors,
  missing,
  disabled,
  onChange,
  onRemove,
}: {
  row: ChannelModel;
  models: CatalogModel[];
  errors?: RowErrors;
  missing: boolean;
  disabled: boolean;
  onChange: (row: ChannelModel) => void;
  onRemove: () => void;
}) {
  const name = row.name.trim();
  const label = name || '新模型';
  return (
    <Grid
      role="group"
      aria-label={label}
      templateColumns={rowColumns}
      templateAreas={rowAreas}
      columnGap="3"
      rowGap="2"
      alignItems="start"
      py="3"
      borderTopWidth="1px"
      borderColor="gray.100"
      _first={{ borderTopWidth: 0, pt: 0 }}
    >
      <Field.Root gridArea="name" invalid={Boolean(errors?.name)} minW="0">
        <InputGroup startElement={modelBrand(name) ? <ModelIcon model={name} /> : undefined}>
          <Input
            aria-label="对外名称"
            value={row.name}
            autoComplete="off"
            spellCheck={false}
            maxLength={128}
            disabled={disabled}
            onChange={(event) => onChange({ ...row, name: event.target.value })}
            borderRadius="lg"
            focusRingColor={brandColor}
          />
        </InputGroup>
        {errors?.name && <Field.ErrorText>{errors.name}</Field.ErrorText>}
        {name && !errors?.name && (
          <HStack gap="1.5" flexWrap="wrap" _empty={{ display: 'none' }}>
            <ModelStatus name={name} models={models} />
            {missing && <Badge colorPalette="orange">上游未返回</Badge>}
          </HStack>
        )}
      </Field.Root>
      <Field.Root gridArea="upstream" invalid={Boolean(errors?.upstream)} minW="0">
        <Input
          aria-label="上游模型名"
          value={row.upstreamModel ?? ''}
          placeholder="同对外名称"
          autoComplete="off"
          spellCheck={false}
          maxLength={128}
          disabled={disabled}
          onChange={(event) => onChange({ ...row, upstreamModel: event.target.value || null })}
          borderRadius="lg"
          focusRingColor={brandColor}
        />
        {errors?.upstream && <Field.ErrorText>{errors.upstream}</Field.ErrorText>}
      </Field.Root>
      <Input
        gridArea="multiplier"
        aria-label="专属倍率"
        value={row.multiplier ?? ''}
        inputMode="decimal"
        placeholder="继承整体倍率"
        disabled={disabled}
        onChange={(event) => onChange({ ...row, multiplier: event.target.value || null })}
        borderRadius="lg"
        focusRingColor={brandColor}
      />
      <IconButton
        gridArea="remove"
        type="button"
        aria-label={`移除 ${label}`}
        variant="ghost"
        size="sm"
        mt="1"
        disabled={disabled}
        onClick={onRemove}
      >
        <X size={16} aria-hidden="true" />
      </IconButton>
    </Grid>
  );
}

export function ChannelModels({
  value,
  onChange,
  models,
  disabled,
  fetching,
  onFetch,
  fetchError,
  fetchNotice,
  importPanel,
  upstreamNames,
  derived = false,
  editableMultipliers = true,
}: {
  value: ChannelModel[];
  onChange: (value: ChannelModel[]) => void;
  models: CatalogModel[];
  disabled: boolean;
  fetching: boolean;
  onFetch: () => void;
  fetchError?: string;
  fetchNotice?: string;
  /** 从上游拉取后的导入列表。 */
  importPanel?: ReactNode;
  /** 最近一次拉取返回的上游模型名，用于标记上游未返回的模型。 */
  upstreamNames?: ReadonlySet<string>;
  derived?: boolean;
  editableMultipliers?: boolean;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const errors = channelModelErrors(value);
  function add() {
    const names = [...new Set(draft.split(/[\s,，;；]+/).filter(Boolean))];
    if (!names.length) return;
    if (names.some((name) => !validModelName(name))) {
      setError(`模型名称${modelNameError}`);
      return;
    }
    const additions = names.filter((name) => !value.some((model) => model.name.trim() === name));
    if (value.length + additions.length > 1000) {
      setError('每个渠道最多添加 1000 个模型');
      return;
    }
    onChange([...value, ...additions.map((name) => channelModel(name))]);
    setDraft('');
    setError(undefined);
  }
  if (derived)
    return editableMultipliers && value.length > 0 ? (
      <Box as="fieldset" minW="0">
        <Text as="legend" fontSize="sm" fontWeight="500" mb="2">
          模型专属倍率
        </Text>
        <Grid
          templateColumns={{ base: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' }}
          rowGap="4"
          columnGap="6"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="lg"
          p="4"
          maxH="360px"
          overflowY="auto"
        >
          {value.map((model) => (
            <MultiplierField
              key={model.key}
              model={model}
              disabled={disabled}
              onChange={(multiplier) =>
                onChange(value.map((item) => (item.key === model.key ? { ...item, multiplier } : item)))
              }
            />
          ))}
        </Grid>
      </Box>
    ) : null;
  return (
    <Stack gap="3">
      <Field.Root invalid={Boolean(error)}>
        <Field.Label htmlFor={inputId}>可用模型</Field.Label>
        <Textarea
          id={inputId}
          value={draft}
          placeholder="输入对外名称，可用换行或逗号批量添加"
          rows={3}
          maxLength={130000}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(undefined);
          }}
          borderRadius="lg"
          focusRingColor={brandColor}
        />
        {error && <Field.ErrorText>{error}</Field.ErrorText>}
      </Field.Root>
      <HStack gap="2" flexWrap="wrap">
        <Button type="button" variant="outline" size="sm" disabled={disabled || !draft.trim()} onClick={add}>
          <Plus size={16} aria-hidden="true" />
          添加模型
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled && !fetching}
          loading={fetching}
          onClick={onFetch}
        >
          <Download size={16} aria-hidden="true" />
          从上游拉取
        </Button>
        <Text fontSize="xs" color="gray.500">
          已添加 {value.length} / 1000
        </Text>
      </HStack>
      <ErrorText>{fetchError}</ErrorText>
      {fetchNotice && (
        <Text role="status" fontSize="sm" color="gray.500">
          {fetchNotice}
        </Text>
      )}
      {importPanel}
      {value.length > 0 && (
        <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" p="4" maxH="420px" overflowY="auto">
          <Grid
            templateColumns={rowColumns}
            columnGap="3"
            mb="2"
            display={{ base: 'none', sm: 'grid' }}
            fontSize="xs"
            color="gray.500"
            aria-hidden="true"
          >
            <Text>对外名称</Text>
            <Text>上游模型名</Text>
            <Text>专属倍率</Text>
          </Grid>
          {value.map((row) => (
            <ModelRow
              key={row.key}
              row={row}
              models={models}
              errors={errors.get(row.key)}
              missing={Boolean(upstreamNames && !upstreamNames.has(effectiveUpstream(row)))}
              disabled={disabled}
              onChange={(next) => onChange(value.map((item) => (item.key === row.key ? next : item)))}
              onRemove={() => onChange(value.filter((item) => item.key !== row.key))}
            />
          ))}
        </Box>
      )}
    </Stack>
  );
}
