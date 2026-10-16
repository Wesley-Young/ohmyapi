import { Input, NativeSelect, Stack, type StackProps } from '@chakra-ui/react';

import { type BrandFilter, brandOptions } from '../lib/model-brands';

export type ModelFilterValue = { search: string; brand: BrandFilter | '' };
export const emptyModelFilter: ModelFilterValue = { search: '', brand: '' };

/** 模型名关键字和厂商筛选；厂商选项取自当前列表。 */
export function ModelFilter({
  models,
  value,
  onChange,
  ...props
}: {
  models: readonly { name: string }[];
  value: ModelFilterValue;
  onChange: (value: ModelFilterValue) => void;
} & Omit<StackProps, 'onChange'>) {
  const options = brandOptions(models);
  return (
    <Stack direction={{ base: 'column', sm: 'row' }} gap="2" {...props}>
      <Input
        size="sm"
        type="search"
        aria-label="搜索模型"
        placeholder="搜索模型…"
        value={value.search}
        onChange={(e) => onChange({ ...value, search: e.target.value })}
      />
      <NativeSelect.Root size="sm">
        <NativeSelect.Field
          aria-label="厂商"
          value={value.brand}
          onChange={(e) =>
            onChange({ ...value, brand: options.find((option) => option.id === e.target.value)?.id ?? '' })
          }
        >
          <option value="">全部厂商</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
    </Stack>
  );
}
