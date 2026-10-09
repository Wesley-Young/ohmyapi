import { Badge, Box, Button, Field, Grid, HStack, Input, Stack, Text, Textarea } from '@chakra-ui/react';
import type { RouterInputs, RouterOutputs } from '@ohmyapi/daemon/trpc';
import { Download, Plus, X } from 'lucide-react';
import { useId, useState } from 'react';

import { IconButton } from './icon-button';
import { ErrorText } from './ui';

export type ChannelModel = NonNullable<RouterInputs['admin']['catalog']['saveChannel']['availableModels']>[number];
type Model = RouterOutputs['admin']['catalog']['list']['models'][number];

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
        {model.name}
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
        focusRingColor="#635bff"
      />
    </Field.Root>
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
}: {
  value: ChannelModel[];
  onChange: (value: ChannelModel[]) => void;
  models: Model[];
  disabled: boolean;
  fetching: boolean;
  onFetch: () => void;
  fetchError?: string;
  fetchNotice?: string;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  function add() {
    const names = [...new Set(draft.split(/[\s,，;；]+/).filter(Boolean))];
    if (!names.length) return;
    if (names.some((name) => name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/.test(name))) {
      setError('模型名称需为 1–128 个字符，仅支持字母、数字和 _ . / : -');
      return;
    }
    const additions = names.filter((name) => !value.some((model) => model.name === name));
    if (value.length + additions.length > 1000) {
      setError('每个渠道最多添加 1000 个模型');
      return;
    }
    onChange([...value, ...additions.map((name) => ({ name, multiplier: null }))]);
    setDraft('');
    setError(undefined);
  }
  return (
    <>
      <Stack gap="3">
        <Field.Root invalid={Boolean(error)}>
          <Field.Label htmlFor={inputId}>可用模型</Field.Label>
          <Textarea
            id={inputId}
            value={draft}
            placeholder="输入模型名称，可用换行或逗号批量添加"
            rows={3}
            maxLength={130000}
            disabled={disabled}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(undefined);
            }}
            borderRadius="lg"
            focusRingColor="#635bff"
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
        {value.length > 0 && (
          <Grid
            templateColumns={{ base: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' }}
            rowGap="1"
            columnGap="4"
            maxH="240px"
            overflowY="auto"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="lg"
            p="2"
          >
            {value.map((model) => {
              const existing = models.find((item) => item.name === model.name);
              return (
                <HStack key={model.name} justify="space-between" gap="3" px="2" py="1" minW="0">
                  <HStack gap="2" flexWrap="wrap" minW="0">
                    <Text fontSize="sm" overflowWrap="anywhere">
                      {model.name}
                    </Text>
                    {!existing ? (
                      <Badge colorPalette="gray">待创建</Badge>
                    ) : (
                      !existing.priced && <Badge colorPalette="gray">未定价</Badge>
                    )}
                    {existing && !existing.enabled && <Badge colorPalette="gray">已禁用</Badge>}
                  </HStack>
                  <IconButton
                    type="button"
                    aria-label={`移除 ${model.name}`}
                    variant="ghost"
                    size="xs"
                    disabled={disabled}
                    flexShrink="0"
                    onClick={() => onChange(value.filter((item) => item.name !== model.name))}
                  >
                    <X size={14} aria-hidden="true" />
                  </IconButton>
                </HStack>
              );
            })}
          </Grid>
        )}
      </Stack>
      {value.length > 0 && (
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
                key={model.name}
                model={model}
                disabled={disabled}
                onChange={(multiplier) =>
                  onChange(value.map((item) => (item.name === model.name ? { ...item, multiplier } : item)))
                }
              />
            ))}
          </Grid>
        </Box>
      )}
    </>
  );
}
