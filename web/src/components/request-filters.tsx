import { Button, Field, HStack, Input, NativeSelect, Stack } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { dateTimeInput, formError } from '../lib/format';
import { emptyRequestFilters, type RequestFilters, type RequestRange, requestRanges } from '../lib/request-filters';
import { trpc } from '../lib/trpc';
import { ErrorText, PrimaryButton } from './ui';

type Option = { id: string; name: string };

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}) {
  return (
    <Field.Root minW="0">
      <Field.Label>{label}</Field.Label>
      <NativeSelect.Root size="sm">
        <NativeSelect.Field value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
    </Field.Root>
  );
}

export function RequestFilterBar({
  applied,
  platform,
  onChange,
}: {
  applied: RequestFilters;
  platform: boolean;
  onChange: (value: RequestFilters) => void;
}) {
  const [model, setModel] = useState(applied.model);
  const [start, setStart] = useState(applied.start);
  const [end, setEnd] = useState(applied.end);
  useEffect(() => setModel(applied.model), [applied.model]);
  useEffect(() => {
    setStart(applied.start);
    setEnd(applied.end);
  }, [applied.start, applied.end]);

  const own = useQuery(trpc.requestFilterOptions.queryOptions(undefined, { enabled: !platform, staleTime: 0 }));
  const all = useQuery(trpc.admin.requestFilterOptions.queryOptions(undefined, { enabled: platform, staleTime: 0 }));
  const rangeOptions = Object.entries(requestRanges).map(([id, name]) => ({ id, name }));
  const allOption = { id: '', name: '全部' };
  const set = <K extends keyof RequestFilters>(key: K, value: RequestFilters[K]) =>
    onChange({ ...applied, [key]: value });
  const chips = [
    {
      key: 'range',
      label: '时间',
      value:
        applied.range === 'custom'
          ? `${applied.start} 至 ${applied.end}`
          : applied.range !== 'all'
            ? requestRanges[applied.range]
            : '',
    },
    { key: 'model', label: '模型', value: applied.model },
    ...(
      [
        ['userId', '用户', all.data?.users],
        ['channelId', '渠道', all.data?.channels],
        ['apiKeyId', 'API Key', own.data],
      ] as const
    ).map(([key, label, options]) => ({
      key,
      label,
      value: applied[key] ? (options?.find((o) => o.id === applied[key])?.name ?? (options ? '已失效' : '…')) : '',
    })),
  ] as const;
  const active = chips.filter((chip) => chip.value);
  return (
    <Stack gap="3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onChange({ ...applied, model: model.trim(), start, end });
        }}
      >
        <HStack
          align="end"
          gap="3"
          flexWrap="wrap"
          css={{ '& > [data-scope="field"]': { flex: '1 1 145px', minWidth: 0 } }}
        >
          <FilterSelect
            label="时间范围"
            options={rangeOptions}
            value={applied.range}
            onChange={(v) => {
              const range = v as RequestRange;
              const today = dateTimeInput(new Date().toISOString()).slice(0, 10);
              onChange({
                ...applied,
                range,
                start: range === 'custom' ? today : '',
                end: range === 'custom' ? today : '',
              });
            }}
          />
          {applied.range === 'custom' && (
            <>
              <Field.Root>
                <Field.Label>开始日期</Field.Label>
                <Input
                  type="date"
                  size="sm"
                  required
                  max={end || undefined}
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </Field.Root>
              <Field.Root>
                <Field.Label>结束日期</Field.Label>
                <Input
                  type="date"
                  size="sm"
                  required
                  min={start || undefined}
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </Field.Root>
            </>
          )}
          <Field.Root>
            <Field.Label>模型</Field.Label>
            <Input
              type="search"
              size="sm"
              placeholder="输入模型名称"
              maxLength={256}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </Field.Root>
          {platform ? (
            <>
              <FilterSelect
                label="用户"
                options={[allOption, ...(all.data?.users ?? [])]}
                value={applied.userId}
                onChange={(v) => set('userId', v)}
              />
              <FilterSelect
                label="渠道"
                options={[allOption, ...(all.data?.channels ?? [])]}
                value={applied.channelId}
                onChange={(v) => set('channelId', v)}
              />
            </>
          ) : (
            <FilterSelect
              label="API Key"
              options={[allOption, ...(own.data ?? [])]}
              value={applied.apiKeyId}
              onChange={(v) => set('apiKeyId', v)}
            />
          )}

          <HStack gap="1">
            <PrimaryButton type="submit" size="sm">
              查询
            </PrimaryButton>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                setModel('');
                setStart('');
                setEnd('');
                onChange({ ...emptyRequestFilters, section: applied.section });
              }}
            >
              重置
            </Button>
          </HStack>
        </HStack>
      </form>
      <ErrorText>{formError(platform ? all.error : own.error)?.message}</ErrorText>
      {active.length > 0 && (
        <HStack flexWrap="wrap" gap="2">
          {active.map(({ key, label, value }) => (
            <Button
              key={key}
              size="xs"
              variant="subtle"
              maxW="full"
              whiteSpace="normal"
              h="auto"
              py="1"
              aria-label={`移除${label}筛选`}
              onClick={() =>
                onChange({
                  ...applied,
                  [key]: emptyRequestFilters[key],
                  ...(key === 'range' ? { start: '', end: '' } : {}),
                })
              }
            >
              {label}：{value}
              <X size={12} />
            </Button>
          ))}
        </HStack>
      )}
    </Stack>
  );
}
