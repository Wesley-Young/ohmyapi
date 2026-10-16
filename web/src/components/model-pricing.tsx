import { Box, Button, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { formError } from '../lib/format';
import { dayNames, defaultRule, kinds, minuteText, type Rule } from '../lib/pricing';
import { queryClient, trpc } from '../lib/trpc';
import { IconButton } from './icon-button';
import { PricingPreview } from './pricing-preview';
import { RuleForm } from './pricing-rule-form';
import { ErrorText, Loading, NameAction, PrimaryButton, pinnedColumn } from './ui';

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
  return (
    <Stack gap="7">
      <HStack justify="space-between" gap="4" flexWrap="wrap">
        <Stack gap="1">
          <Heading as="h3" fontSize="lg">
            定价规则
          </Heading>
          <Text fontSize="sm" color="gray.500">
            单价 / 百万 Token
          </Text>
        </Stack>
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
            <Table.Root size="sm" whiteSpace="nowrap">
              <Table.Header>
                <Table.Row>
                  {['规则名称', '条件', '输入', '输出', '缓存读', '缓存写', '搜索 / 千次', '预览搜索 / 千次'].map(
                    (h) => (
                      <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
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
                    </Table.Cell>
                    <Table.Cell>
                      <Text fontWeight="500">{kinds[r.kind]}</Text>
                      {r.contextMin !== null && (
                        <Text fontSize="xs" color="gray.500">
                          [{r.contextMin}, {r.contextMax ?? '∞'}) Token
                        </Text>
                      )}
                      {r.weekdaysMask !== null && (
                        <Text fontSize="xs" color="gray.500">
                          {dayNames
                            .filter((_, i) => (r.weekdaysMask as number) & (1 << i))
                            .map((d) => `周${d}`)
                            .join('、')}{' '}
                          {minuteText(r.startMinute)}–{minuteText(r.endMinute)}
                        </Text>
                      )}
                    </Table.Cell>
                    <Table.Cell>{r.inputPrice}</Table.Cell>
                    <Table.Cell>{r.outputPrice}</Table.Cell>
                    <Table.Cell>{r.cacheReadPrice ?? '—'}</Table.Cell>
                    <Table.Cell>{r.cacheWritePrice ?? '—'}</Table.Cell>
                    <Table.Cell>{r.webSearchPrice ?? data.data.searchDefaults.webSearchPrice ?? '—'}</Table.Cell>
                    <Table.Cell>
                      {r.webSearchPreviewPrice ?? data.data.searchDefaults.webSearchPreviewPrice ?? '—'}
                    </Table.Cell>
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
          {currentRules.length > 0 && (
            <PricingPreview key={data.data.rules.map((r) => r.id).join(':')} modelId={modelId} />
          )}
        </>
      ) : null}
    </Stack>
  );
}
