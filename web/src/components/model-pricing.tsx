import { Box, Button, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Calculator, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { displayMoney, formatCount, formError } from '../lib/format';
import { dayNames, defaultRule, kinds, minuteText, type Rule } from '../lib/pricing';
import { queryClient, trpc } from '../lib/trpc';
import { IconButton } from './icon-button';
import { PricingPreview } from './pricing-preview';
import { RuleForm } from './pricing-rule-form';
import { ErrorText, Loading, NameAction, PrimaryButton, pinnedColumn } from './ui';

type PricingRule = RouterOutputs['admin']['pricing']['list']['rules'][number];

/** 规则的生效条件，如「≥ 200,000 Token」「周一、周二 09:00–18:00」。 */
function conditionText(r: PricingRule) {
  const parts = [];
  if (r.contextMin !== null)
    parts.push(
      r.contextMax === null
        ? `≥ ${formatCount(r.contextMin)} Token`
        : `≥ ${formatCount(r.contextMin)} 且 < ${formatCount(r.contextMax)} Token`,
    );
  if (r.weekdaysMask !== null)
    parts.push(
      `${dayNames
        .filter((_, i) => (r.weekdaysMask as number) & (1 << i))
        .map((d) => `周${d}`)
        .join('、')} ${minuteText(r.startMinute)}–${minuteText(r.endMinute)}`,
    );
  return parts.length ? parts.join('，') : kinds[r.kind];
}

const price = (value: string | null | undefined) => (value ? displayMoney(value) : '—');

export function ModelPricing({
  modelId,
  copyLunaPrice = false,
  lunaModelId,
}: {
  modelId: string;
  copyLunaPrice?: boolean;
  lunaModelId?: string;
}) {
  const scope = { modelId };
  const data = useQuery(trpc.admin.pricing.list.queryOptions(scope));
  const lunaPricing = useQuery(
    trpc.admin.pricing.list.queryOptions({ modelId: lunaModelId ?? '' }, { enabled: copyLunaPrice && !!lunaModelId }),
  );
  const [editingRule, setEditingRule] = useState<{ index?: number; rule: Rule }>();
  const [previewing, setPreviewing] = useState(false);
  const save = useMutation(
    trpc.admin.pricing.save.mutationOptions({
      onSuccess: async () => {
        setEditingRule(undefined);
        await Promise.all([
          queryClient.invalidateQueries(trpc.admin.pricing.list.queryFilter(scope)),
          queryClient.invalidateQueries(trpc.admin.catalog.list.queryFilter()),
        ]);
      },
    }),
  );
  const currentRules = data.data?.rules.map(({ id: _id, ...r }) => r) ?? [];
  const searchDefaults = data.data?.searchDefaults;
  // 规则和默认值都没有搜索价格时，不显示搜索相关的列和输入。
  const hasSearch =
    !!searchDefaults?.webSearchPrice ||
    !!searchDefaults?.webSearchPreviewPrice ||
    currentRules.some((r) => r.webSearchPrice || r.webSearchPreviewPrice);
  return (
    <Stack gap="4">
      <HStack justify="space-between" gap="4" flexWrap="wrap">
        <HStack gap="2" align="baseline">
          <Heading as="h3" fontSize="md">
            定价规则
          </Heading>
          <Text fontSize="xs" color="gray.500">
            单价 / 百万 Token
          </Text>
        </HStack>
        <HStack gap="2" flexWrap="wrap">
          {copyLunaPrice && (
            <Button
              size="sm"
              variant="outline"
              disabled={
                !data.data ||
                !lunaModelId ||
                !lunaPricing.data?.rules.some((rule) => rule.kind === 'default') ||
                save.isPending
              }
              onClick={() => {
                if (!lunaPricing.data) return;
                save.mutate({
                  modelId,
                  rules: lunaPricing.data.rules.map(({ id: _id, ...rule }) => rule),
                });
              }}
            >
              复制 GPT-5.6 Luna 价格
            </Button>
          )}
          {currentRules.length > 0 && (
            <Button size="sm" variant="ghost" aria-haspopup="dialog" onClick={() => setPreviewing(true)}>
              <Calculator size={14} aria-hidden="true" />
              费用试算
            </Button>
          )}
          <PrimaryButton
            size="sm"
            disabled={!data.data || save.isPending}
            onClick={() => {
              save.reset();
              setEditingRule({
                rule: {
                  ...defaultRule,
                  kind: currentRules.length ? 'context' : 'default',
                  contextMin: currentRules.length ? '0' : null,
                },
              });
            }}
          >
            添加规则
          </PrimaryButton>
        </HStack>
      </HStack>
      {copyLunaPrice && !lunaModelId && (
        <Text fontSize="sm" color="gray.500">
          请先为 gpt-5.6-luna 定价。
        </Text>
      )}
      <ErrorText>{copyLunaPrice ? formError(lunaPricing.error)?.message : undefined}</ErrorText>
      <ErrorText>{formError(data.error)?.message}</ErrorText>
      {data.isPending ? (
        <Loading />
      ) : data.data ? (
        <>
          <ErrorText>{formError(save.error)?.message}</ErrorText>
          <Box overflowX="auto">
            <Table.Root size="sm" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>规则</Table.ColumnHeader>
                  {['输入', '输出', '缓存读', '缓存写', ...(hasSearch ? ['搜索 / 千次', '预览搜索 / 千次'] : [])].map(
                    (h) => (
                      <Table.ColumnHeader key={h} textAlign="end">
                        {h}
                      </Table.ColumnHeader>
                    ),
                  )}
                  <Table.ColumnHeader {...pinnedColumn}>操作</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.data.rules.map((r, index) => (
                  <Table.Row key={r.id}>
                    <Table.Cell>
                      <NameAction
                        aria-haspopup="dialog"
                        disabled={save.isPending}
                        onClick={() => {
                          save.reset();
                          setEditingRule({ index, rule: currentRules[index] });
                        }}
                      >
                        {r.label}
                      </NameAction>
                      <Text fontSize="xs" color="gray.500">
                        {conditionText(r)}
                      </Text>
                    </Table.Cell>
                    <Table.Cell textAlign="end">{price(r.inputPrice)}</Table.Cell>
                    <Table.Cell textAlign="end">{price(r.outputPrice)}</Table.Cell>
                    <Table.Cell textAlign="end">{price(r.cacheReadPrice)}</Table.Cell>
                    <Table.Cell textAlign="end">{price(r.cacheWritePrice)}</Table.Cell>
                    {hasSearch && (
                      <>
                        <Table.Cell textAlign="end">
                          {price(r.webSearchPrice ?? data.data.searchDefaults.webSearchPrice)}
                        </Table.Cell>
                        <Table.Cell textAlign="end">
                          {price(r.webSearchPreviewPrice ?? data.data.searchDefaults.webSearchPreviewPrice)}
                        </Table.Cell>
                      </>
                    )}
                    <Table.Cell {...pinnedColumn}>
                      <HStack gap="1">
                        <IconButton
                          aria-label="编辑价格规则"
                          variant="ghost"
                          size="sm"
                          disabled={save.isPending}
                          onClick={() => {
                            save.reset();
                            setEditingRule({ index, rule: currentRules[index] });
                          }}
                        >
                          <Pencil size={16} aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          aria-label="删除价格规则"
                          variant="ghost"
                          size="sm"
                          color="red.500"
                          disabled={save.isPending || (r.kind === 'default' && currentRules.length > 1)}
                          onClick={() => save.mutate({ modelId, rules: currentRules.filter((_, i) => i !== index) })}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </IconButton>
                      </HStack>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
          {!currentRules.length && (
            <Text color="gray.500" fontSize="sm">
              请添加默认价格及所需条件规则。
            </Text>
          )}
          {editingRule && (
            <RuleForm
              initial={editingRule.rule}
              searchDefaults={data.data.searchDefaults}
              busy={save.isPending}
              error={formError(save.error)?.message}
              close={() => setEditingRule(undefined)}
              save={(rule) => {
                if (save.isPending) return;
                const rules = [...currentRules];
                if (editingRule.index === undefined) rules.push(rule);
                else rules[editingRule.index] = rule;
                save.mutate({ modelId, rules });
              }}
            />
          )}
          {previewing && <PricingPreview modelId={modelId} showSearch={hasSearch} close={() => setPreviewing(false)} />}
        </>
      ) : null}
    </Stack>
  );
}
