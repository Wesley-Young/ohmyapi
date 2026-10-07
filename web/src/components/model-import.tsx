import { Badge, Box, Button, Checkbox, Grid, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { formError } from '../lib/format';
import {
  buildImportRules,
  convertPrices,
  fetchModelsDev,
  type ImportPreset,
  importPresets,
  type SourceModel,
  suggestedPreset,
} from '../lib/models-dev';
import { trpc } from '../lib/trpc';
import { refreshCatalog, SelectField } from '../routes/Catalog';
import { ErrorText, FormDialog, FormInput, Loading, PageControls, PrimaryButton } from './ui';

type Selection = { source: SourceModel; preset: ImportPreset };
type Result = RouterOutputs['admin']['catalog']['importModels'];
const pageSize = 50;
const priceColumns = [
  ['inputPrice', '输入'],
  ['outputPrice', '输出'],
  ['cacheReadPrice', '缓存读'],
  ['cacheWritePrice', '缓存写'],
] as const;
const minuteText = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const priceText = (price: string | null) =>
  price === null ? '未配置' : price.includes('.') ? price.replace(/0+$/, '').replace(/\.$/, '') : price;

export function ModelImport({
  existingNames,
  close,
  onImported,
}: {
  existingNames: string[];
  close: () => void;
  onImported: (result: Result) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [search, setSearch] = useState('');
  const [providerId, setProviderId] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Selection[]>([]);
  const [rate, setRate] = useState('');
  const source = useQuery({
    queryKey: ['models-dev'],
    queryFn: ({ signal }) => fetchModelsDev(signal),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const wallet = useQuery(trpc.wallet.get.queryOptions());
  const task = useMutation(
    trpc.admin.catalog.importModels.mutationOptions({
      onSuccess: async (result) => {
        await refreshCatalog();
        onImported(result);
        close();
      },
    }),
  );
  const currency = wallet.data?.currency;
  const allModels = source.data ?? [];
  const providers = [
    ...new Map(
      allModels.map((model) => [model.providerId, { id: model.providerId, name: model.providerName }]),
    ).values(),
  ];
  const term = search.trim().toLowerCase();
  const filtered = allModels.filter(
    (model) =>
      (!providerId || model.providerId === providerId) &&
      `${model.name} ${model.displayName} ${model.providerName}`.toLowerCase().includes(term),
  );
  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const existing = new Set(existingNames);
  const selectedNames = new Set(selected.map((item) => item.source.name));
  const selectedKeys = new Set(selected.map((item) => item.source.key));

  let preview: { selection: Selection; rules: ReturnType<typeof buildImportRules> }[] = [];
  let previewError: string | undefined;
  if (step === 2) {
    try {
      preview = selected.map((selection) => ({
        selection,
        rules: buildImportRules(
          currency && currency !== 'USD' ? convertPrices(selection.source.prices, rate) : selection.source.prices,
          selection.preset,
        ),
      }));
    } catch (error) {
      previewError = (error as Error).message;
    }
  }
  const choosePage = () => {
    const names = new Set(selectedNames);
    const next = [...selected];
    for (const model of visible) {
      if (next.length >= 100) break;
      if (existing.has(model.name) || names.has(model.name)) continue;
      next.push({ source: model, preset: suggestedPreset(model.name) });
      names.add(model.name);
    }
    setSelected(next);
  };

  return (
    <FormDialog open title="从 models.dev 导入模型" onClose={close} busy={task.isPending} size="xl">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (task.isPending) return;
          if (step === 1) {
            if (selected.length) setStep(2);
            return;
          }
          if (!currency || previewError || !preview.length) return;
          task.mutate({
            models: preview.map(({ selection, rules }) => ({
              model: {
                name: selection.source.name,
                enabled: true,
                inputTokenLimit: selection.source.inputTokenLimit,
                outputTokenLimit: selection.source.outputTokenLimit,
              },
              providerId: selection.source.providerId,
              preset: selection.preset,
              rules,
            })),
          });
        }}
      >
        <Stack gap="5" minW="0">
          <HStack gap="2" flexWrap="wrap">
            <Badge colorPalette="gray" variant={step === 1 ? 'solid' : 'subtle'}>
              1 选择模型
            </Badge>
            <Badge colorPalette="gray" variant={step === 2 ? 'solid' : 'subtle'}>
              2 预览定价与预设
            </Badge>
            <Text fontSize="sm" color="gray.500">
              已选 {selected.length} / 100
            </Text>
          </HStack>
          {step === 1 ? (
            <>
              <Grid templateColumns={{ base: '1fr', sm: 'minmax(0, 1fr) minmax(0, 1fr)' }} gap="4">
                <FormInput
                  label="搜索模型"
                  value={search}
                  placeholder="模型名称或供应商"
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(0);
                  }}
                />
                <SelectField
                  label="供应商（留空显示全部）"
                  value={providerId}
                  options={providers}
                  onChange={(value) => {
                    setProviderId(value);
                    setPage(0);
                  }}
                />
              </Grid>
              <HStack justify="space-between" flexWrap="wrap" gap="2">
                <Text fontSize="xs" color="gray.500">
                  同名模型选择一个供应商；已有模型不会覆盖。仅列出具有输入和输出价格的模型。
                </Text>
                <HStack>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={!visible.length || selected.length >= 100}
                    onClick={choosePage}
                  >
                    选择本页
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={!selected.length}
                    onClick={() => setSelected([])}
                  >
                    清空选择
                  </Button>
                </HStack>
              </HStack>
              {source.isPending ? (
                <Loading />
              ) : source.error ? (
                <Stack align="start" gap="2">
                  <ErrorText>{source.error.message}</ErrorText>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={source.isFetching}
                    onClick={() => void source.refetch()}
                  >
                    重试
                  </Button>
                </Stack>
              ) : (
                <>
                  <Box maxH="380px" overflow="auto" borderWidth="1px" borderColor="gray.200" borderRadius="lg">
                    <Table.Root size="sm" stickyHeader>
                      <Table.Header>
                        <Table.Row>
                          <Table.ColumnHeader>选择</Table.ColumnHeader>
                          <Table.ColumnHeader>模型</Table.ColumnHeader>
                          <Table.ColumnHeader>供应商</Table.ColumnHeader>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {visible.map((model) => {
                          const checked = selectedKeys.has(model.key);
                          const alreadyExists = existing.has(model.name);
                          const otherSource = selectedNames.has(model.name) && !checked;
                          return (
                            <Table.Row key={model.key}>
                              <Table.Cell>
                                <Checkbox.Root
                                  checked={checked}
                                  disabled={alreadyExists || otherSource || (!checked && selected.length >= 100)}
                                  onCheckedChange={(event) => {
                                    setSelected((items) =>
                                      event.checked
                                        ? [...items, { source: model, preset: suggestedPreset(model.name) }]
                                        : items.filter((item) => item.source.key !== model.key),
                                    );
                                  }}
                                >
                                  <Checkbox.HiddenInput aria-label={`选择 ${model.providerName} 的 ${model.name}`} />
                                  <Checkbox.Control />
                                </Checkbox.Root>
                              </Table.Cell>
                              <Table.Cell minW="180px" maxW="380px">
                                <Stack gap="1">
                                  <Text fontSize="sm" fontWeight="500" overflowWrap="anywhere">
                                    {model.name}
                                  </Text>
                                  {model.displayName !== model.name && (
                                    <Text fontSize="xs" color="gray.500" overflowWrap="anywhere">
                                      {model.displayName}
                                    </Text>
                                  )}
                                  {alreadyExists && (
                                    <Badge colorPalette="gray" alignSelf="start">
                                      已存在
                                    </Badge>
                                  )}
                                  {otherSource && (
                                    <Badge colorPalette="gray" alignSelf="start">
                                      已选其他来源
                                    </Badge>
                                  )}
                                </Stack>
                              </Table.Cell>
                              <Table.Cell>
                                <Badge colorPalette="gray" whiteSpace="normal" overflowWrap="anywhere">
                                  {model.providerName}
                                </Badge>
                              </Table.Cell>
                            </Table.Row>
                          );
                        })}
                      </Table.Body>
                    </Table.Root>
                    {!visible.length && (
                      <Text p="6" textAlign="center" fontSize="sm" color="gray.500">
                        没有匹配的模型
                      </Text>
                    )}
                  </Box>
                  <HStack justify="space-between" flexWrap="wrap" gap="3">
                    <Text fontSize="sm" color="gray.500">
                      共 {filtered.length} 个模型来源
                    </Text>
                    <PageControls page={page} hasMore={(page + 1) * pageSize < filtered.length} onPage={setPage} />
                  </HStack>
                </>
              )}
            </>
          ) : (
            <>
              <Stack gap="2" fontSize="sm" color="gray.500">
                <Text>基础价格来自 models.dev，单位为 USD / 百万 Token。下方规则就是将要保存的价格。</Text>
                <Text>GPT：上下文超过 272k 时，输出 1.5×，输入、缓存读和缓存写 2×。</Text>
                <Text>
                  DeepSeek：上海时区周一至周五 09:00–12:00、14:00–18:00，四项价格均为 2×；其余时段使用基础价。
                </Text>
                <Text>缺失的缓存价格保留为未配置；金额最多六位小数，超出精度时向上舍入。</Text>
              </Stack>
              <ErrorText>{formError(wallet.error)?.message}</ErrorText>
              {wallet.isPending && <Loading />}
              {currency && currency !== 'USD' && (
                <FormInput
                  label={`USD → ${currency} 换算系数`}
                  value={rate}
                  inputMode="decimal"
                  required
                  disabled={task.isPending}
                  helper="按你填写的系数换算后保存，不自动获取汇率。"
                  onChange={(event) => setRate(event.target.value)}
                />
              )}
              <ErrorText>{previewError}</ErrorText>
              {selected.map((selection) => {
                const rules = preview.find((item) => item.selection === selection)?.rules;
                return (
                  <Box
                    key={selection.source.key}
                    borderWidth="1px"
                    borderColor="gray.200"
                    borderRadius="lg"
                    p="4"
                    minW="0"
                  >
                    <Stack gap="4">
                      <Stack gap="2">
                        <Heading as="h3" fontSize="md" overflowWrap="anywhere">
                          {selection.source.name}
                        </Heading>
                        <HStack gap="2" flexWrap="wrap">
                          <Badge colorPalette="gray">{selection.source.providerName}</Badge>
                          <Badge colorPalette="gray">
                            输入容量 {selection.source.inputTokenLimit.toLocaleString()}
                          </Badge>
                          <Badge colorPalette="gray">
                            输出上限 {selection.source.outputTokenLimit.toLocaleString()}
                          </Badge>
                        </HStack>
                      </Stack>
                      <Box>
                        <SelectField
                          label={`${selection.source.name} 定价预设`}
                          value={selection.preset}
                          disabled={task.isPending}
                          options={Object.entries(importPresets).map(([id, name]) => ({ id, name }))}
                          onChange={(value) => {
                            if (!value || task.isPending) return;
                            task.reset();
                            setSelected((items) =>
                              items.map((item) =>
                                item.source.key === selection.source.key
                                  ? { ...item, preset: value as ImportPreset }
                                  : item,
                              ),
                            );
                          }}
                        />
                      </Box>
                      {rules && (
                        <Box overflowX="auto">
                          <Table.Root size="sm">
                            <Table.Caption textAlign="start" mt="2">
                              {currency ?? 'USD'} / 百万 Token
                            </Table.Caption>
                            <Table.Header>
                              <Table.Row>
                                <Table.ColumnHeader>条件</Table.ColumnHeader>
                                {priceColumns.map(([key, label]) => (
                                  <Table.ColumnHeader key={key}>{label}</Table.ColumnHeader>
                                ))}
                              </Table.Row>
                            </Table.Header>
                            <Table.Body>
                              {rules.map((rule) => (
                                <Table.Row key={rule.label}>
                                  <Table.Cell minW="160px">
                                    <Text fontSize="sm">
                                      {rule.kind === 'default' ? '默认价格（其余情况）' : rule.label}
                                    </Text>
                                    {rule.contextMin !== null && (
                                      <Badge colorPalette="gray" mt="1">
                                        ≥ {Number(rule.contextMin).toLocaleString()} Token
                                      </Badge>
                                    )}
                                    {rule.startMinute !== null && rule.endMinute !== null && (
                                      <Badge colorPalette="gray" mt="1">
                                        周一至周五 {minuteText(rule.startMinute)}–{minuteText(rule.endMinute)}
                                      </Badge>
                                    )}
                                  </Table.Cell>
                                  {priceColumns.map(([key]) => (
                                    <Table.Cell key={key} whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
                                      {priceText(rule[key])}
                                    </Table.Cell>
                                  ))}
                                </Table.Row>
                              ))}
                            </Table.Body>
                          </Table.Root>
                        </Box>
                      )}
                    </Stack>
                  </Box>
                );
              })}
            </>
          )}
          <ErrorText>{formError(task.error)?.message}</ErrorText>
          <HStack justify="end" gap="3" flexWrap="wrap">
            <Button
              type="button"
              variant="ghost"
              disabled={task.isPending}
              onClick={
                step === 1
                  ? close
                  : () => {
                      task.reset();
                      setStep(1);
                    }
              }
            >
              {step === 1 ? '取消' : '上一步'}
            </Button>
            <PrimaryButton
              type="submit"
              loading={task.isPending}
              disabled={!selected.length || (step === 2 && (!currency || Boolean(previewError)))}
            >
              {step === 1 ? '下一步' : `导入 ${selected.length} 个模型`}
            </PrimaryButton>
          </HStack>
        </Stack>
      </form>
    </FormDialog>
  );
}
