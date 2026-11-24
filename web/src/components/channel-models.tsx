import { Badge, Box, Button, Field, Grid, HStack, Input, Popover, Stack, Text, Textarea } from '@chakra-ui/react';
import type { RouterInputs, RouterOutputs } from '@ohmyapi/daemon/trpc';
import { Download, Gauge, Plus, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

import { brandColor } from '../lib/theme';
import { ModelLabel } from './brand-icon';
import { ChannelDisclosure, ChannelMultiplierField } from './channel-form-layout';
import { IconButton } from './icon-button';
import { ErrorText, FormInput } from './ui';

type ChannelModelInput = NonNullable<RouterInputs['admin']['catalog']['saveChannel']['availableModels']>[number];
/** 渠道弹窗中的一行模型；key 只在界面中区分行，对外名称可以修改。 */
export type ChannelModel = ChannelModelInput & { key: string };
export type CatalogModel = RouterOutputs['admin']['catalog']['list']['models'][number];

let nextKey = 0;
export const channelModel = (
  name: string,
  upstreamModel: string | null = null,
  reasoningEffortRules: EffortRule[] = [],
): ChannelModel => ({
  key: `model-${nextKey++}`,
  name,
  multiplier: null,
  upstreamModel,
  reasoningEffortRules,
});

export type EffortRule = { from: string; to: string };
/** 启用推理强度映射时预置的规则：把最高两档降为 high。 */
export const defaultEffortRules = (): EffortRule[] => [
  { from: 'xhigh', to: 'high' },
  { from: 'max', to: 'high' },
];
const effortPattern = /^[a-z][a-z0-9_-]{0,15}$/;
const normalizeEffort = (value: string) => value.trim().toLowerCase();

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
    reasoningEffortRules: (row.reasoningEffortRules ?? []).map((rule) => ({
      from: normalizeEffort(rule.from),
      to: normalizeEffort(rule.to),
    })),
  }));

type RowErrors = { name?: string; upstream?: string; rules?: string };

function effortRulesError(rules: EffortRule[]) {
  const seen = new Set<string>();
  for (const rule of rules) {
    const from = normalizeEffort(rule.from);
    const to = normalizeEffort(rule.to);
    if (!effortPattern.test(from) || !effortPattern.test(to)) return '推理强度需为 1–16 个字符，仅支持字母、数字和 _ -';
    if (from === to) return '映射前后的推理强度不能相同';
    if (seen.has(from)) return '映射前的推理强度不能重复';
    seen.add(from);
  }
}

function channelModelErrors(rows: ChannelModel[]) {
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
    const rules = effortRulesError(row.reasoningEffortRules ?? []);
    if (rules) error.rules = rules;
    if (error.name || error.upstream || error.rules) errors.set(row.key, error);
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

/**
 * 推理强度映射：请求的强度等于左侧时，转发前改为右侧。图标按钮打开规则编辑；
 * 首次打开时预置 xhigh → high、max → high，规则全部移除即不改写。
 * 弹层不放入 Portal，留在弹窗的焦点范围内。
 */
function EffortRules({
  label,
  rules,
  error,
  disabled,
  onChange,
}: {
  label: string;
  rules: EffortRule[];
  error?: string;
  disabled: boolean;
  onChange: (rules: EffortRule[]) => void;
}) {
  const update = (index: number, next: EffortRule) => onChange(rules.map((rule, i) => (i === index ? next : rule)));
  const summary = rules.map((rule) => `${rule.from.trim() || '?'} → ${rule.to.trim() || '?'}`).join('，');
  return (
    <Popover.Root
      lazyMount
      unmountOnExit
      positioning={{ placement: 'bottom-end', strategy: 'fixed', shift: 12 }}
      onOpenChange={({ open }) => {
        if (open && !rules.length) onChange(defaultEffortRules());
      }}
    >
      <Popover.Trigger asChild>
        <IconButton
          data-channel-error={error}
          type="button"
          aria-label={`${label} 推理强度映射`}
          title={error ?? (summary ? `推理强度映射：${summary}` : '推理强度映射')}
          variant={rules.length ? 'subtle' : 'ghost'}
          color={error ? 'red.600' : rules.length ? brandColor : undefined}
          size="sm"
          disabled={disabled}
        >
          <Gauge size={16} aria-hidden="true" />
        </IconButton>
      </Popover.Trigger>
      <Popover.Positioner>
        <Popover.Content
          w="min(360px, calc(100vw - 24px))"
          borderRadius="xl"
          bg="white"
          borderColor="gray.200"
          boxShadow="0 8px 32px rgba(0, 0, 0, 0.12)"
          pointerEvents="auto"
        >
          <Popover.Body p="4">
            <Field.Root invalid={Boolean(error)} minW="0">
              <Stack gap="2" w="full">
                <Popover.Title fontSize="sm" fontWeight="600">
                  推理强度映射
                </Popover.Title>
                {rules.map((rule, index) => (
                  // 规则没有稳定标识，行内编辑时按位置区分。
                  // biome-ignore lint/suspicious/noArrayIndexKey: 规则可重复编辑且无 id
                  <HStack key={index} gap="2" role="group" aria-label={`${label} 推理强度映射 ${index + 1}`}>
                    <Input
                      aria-label="请求的推理强度"
                      value={rule.from}
                      placeholder="请求"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={16}
                      onChange={(event) => update(index, { ...rule, from: event.target.value })}
                      borderRadius="lg"
                      size="sm"
                      focusRingColor={brandColor}
                    />
                    <Text color="gray.500" aria-hidden="true">
                      →
                    </Text>
                    <Input
                      aria-label="改写为"
                      value={rule.to}
                      placeholder="改为"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={16}
                      onChange={(event) => update(index, { ...rule, to: event.target.value })}
                      borderRadius="lg"
                      size="sm"
                      focusRingColor={brandColor}
                    />
                    <IconButton
                      type="button"
                      aria-label={`移除 ${rule.from.trim() || '空'} 映射`}
                      variant="ghost"
                      size="xs"
                      onClick={() => onChange(rules.filter((_, i) => i !== index))}
                    >
                      <X size={14} aria-hidden="true" />
                    </IconButton>
                  </HStack>
                ))}
                {error && <Field.ErrorText>{error}</Field.ErrorText>}
                <Box>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={rules.length >= 16}
                    onClick={() => onChange([...rules, { from: '', to: '' }])}
                  >
                    <Plus size={14} aria-hidden="true" />
                    添加规则
                  </Button>
                </Box>
              </Stack>
            </Field.Root>
          </Popover.Body>
        </Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  );
}

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
    <ChannelDisclosure
      title={
        <HStack as="span" flexWrap="wrap" gap="2">
          <ModelLabel model={label} overflowWrap="anywhere" />
          {name && <ModelStatus name={name} models={models} />}
          {missing && <Badge colorPalette="orange">上游未返回</Badge>}
        </HStack>
      }
      summary={errors ? '需修正' : row.multiplier ? `${row.multiplier}×` : '继承整体倍率'}
    >
      <Stack gap="3">
        <FormInput
          label="对外名称"
          value={row.name}
          error={errors?.name}
          data-channel-error={errors?.name}
          autoComplete="off"
          spellCheck={false}
          maxLength={128}
          disabled={disabled}
          onChange={(e) => onChange({ ...row, name: e.target.value })}
        />
        <Grid templateColumns={{ base: 'minmax(0,1fr)', sm: 'repeat(2,minmax(0,1fr))' }} gap="3">
          <FormInput
            label="上游模型名"
            value={row.upstreamModel ?? ''}
            placeholder="同对外名称"
            error={errors?.upstream}
            data-channel-error={errors?.upstream}
            autoComplete="off"
            spellCheck={false}
            maxLength={128}
            disabled={disabled}
            onChange={(e) => onChange({ ...row, upstreamModel: e.target.value || null })}
          />
          <ChannelMultiplierField
            value={row.multiplier ?? ''}
            onChange={(value) => onChange({ ...row, multiplier: value || null })}
          />
        </Grid>
        <HStack justify="space-between">
          <HStack gap="1" fontSize="sm">
            推理强度映射
            <EffortRules
              label={label}
              rules={row.reasoningEffortRules ?? []}
              error={errors?.rules}
              disabled={disabled}
              onChange={(reasoningEffortRules) => onChange({ ...row, reasoningEffortRules })}
            />
          </HStack>
          <IconButton aria-label={`移除 ${label}`} variant="ghost" size="sm" disabled={disabled} onClick={onRemove}>
            <X size={16} />
          </IconButton>
        </HStack>
      </Stack>
    </ChannelDisclosure>
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
  const [adding, setAdding] = useState(false);
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
    setAdding(false);
    setError(undefined);
  }
  if (derived)
    return (
      <Stack gap="2" borderTopWidth="1px" pt="4">
        <Text as="h3" fontWeight="600" fontSize="sm">
          可用模型
        </Text>
        {!value.length ? (
          <Text fontSize="sm" color="gray.500">
            请先选择提供模型的子渠道。
          </Text>
        ) : editableMultipliers ? (
          value.map((model) => (
            <ChannelDisclosure
              key={model.key}
              title={<ModelLabel model={model.name} />}
              summary={model.multiplier ? `${model.multiplier}×` : '继承整体倍率'}
            >
              <ChannelMultiplierField
                value={model.multiplier ?? ''}
                onChange={(multiplier) =>
                  onChange(
                    value.map((item) => (item.key === model.key ? { ...item, multiplier: multiplier || null } : item)),
                  )
                }
              />
            </ChannelDisclosure>
          ))
        ) : (
          <HStack flexWrap="wrap" gap="2">
            {value.map((model) => (
              <Badge key={model.key} whiteSpace="normal" overflowWrap="anywhere">
                <ModelLabel model={model.name} />
              </Badge>
            ))}
          </HStack>
        )}
      </Stack>
    );
  return (
    <Stack gap="3" borderTopWidth="1px" pt="4">
      <HStack justify="space-between" flexWrap="wrap">
        <Text as="h3" fontWeight="600" fontSize="sm">
          可用模型{' '}
          <Text as="span" color="gray.500" fontWeight="400">
            ({value.length})
          </Text>
        </Text>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled && !fetching}
          loading={fetching}
          onClick={onFetch}
        >
          <Download size={15} aria-hidden="true" />
          从上游拉取
        </Button>
      </HStack>
      <ErrorText>{fetchError}</ErrorText>
      {fetchNotice && (
        <Text role="status" fontSize="sm" color="gray.500">
          {fetchNotice}
        </Text>
      )}
      {importPanel}
      {value.length > 0 && (
        <Box>
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
      {adding ? (
        <Stack gap="2">
          <Field.Root invalid={Boolean(error)}>
            <Field.Label htmlFor={inputId}>新模型名称</Field.Label>
            <Textarea
              id={inputId}
              value={draft}
              rows={2}
              maxLength={130000}
              disabled={disabled}
              placeholder="输入对外名称，可用换行或逗号批量添加"
              onChange={(e) => {
                setDraft(e.target.value);
                setError(undefined);
              }}
            />
            {error && <Field.ErrorText>{error}</Field.ErrorText>}
          </Field.Root>
          <HStack>
            <Button type="button" variant="outline" size="sm" disabled={disabled || !draft.trim()} onClick={add}>
              加入列表
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setAdding(false)}>
              收起
            </Button>
          </HStack>
        </Stack>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          alignSelf="start"
          disabled={disabled}
          onClick={() => setAdding(true)}
        >
          <Plus size={16} aria-hidden="true" />
          添加模型
        </Button>
      )}
    </Stack>
  );
}
