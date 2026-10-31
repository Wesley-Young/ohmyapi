import { Badge, Box, Grid, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { displayMultiplier, displayRange, formError } from '../lib/format';
import { kinds } from '../lib/pricing';
import { trpc } from '../lib/trpc';
import { SelectField } from './fields';
import { ErrorText, FormInput, Panel, PrimaryButton } from './ui';

/** 预览时间按上海时间（UTC+8）输入和换算。 */
const shanghaiNow = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16);
const isoShanghai = (value: string) => new Date(`${value}:00+08:00`).toISOString();

export function PricingPreview({ modelId }: { modelId: string }) {
  const [at, setAt] = useState(shanghaiNow);
  const [counts, setCounts] = useState({
    inputTokens: '0',
    outputTokens: '0',
    cacheReadTokens: '0',
    cacheWriteTokens: '0',
    webSearchCalls: '0',
    webSearchPreviewCalls: '0',
  });
  const [channelId, setChannelId] = useState('');
  const [multiplier, setMultiplier] = useState('1');
  const catalog = useQuery(trpc.admin.catalog.list.queryOptions());
  const task = useMutation(trpc.admin.pricing.preview.mutationOptions());
  return (
    <Panel>
      <Stack gap="5">
        <Heading as="h2" fontSize="lg">
          费用预览
        </Heading>
        <form
          onChange={() => {
            if (!task.isPending) task.reset();
          }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!task.isPending)
              task.mutate({
                modelId,
                at: isoShanghai(at),
                ...counts,
                channelId: channelId || undefined,
                multiplier: channelId ? undefined : multiplier,
              });
          }}
        >
          <Stack gap="4">
            <FormInput
              label="请求时间（上海时区）"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              required
            />
            <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap="4">
              {(
                [
                  ['inputTokens', '普通输入 Token'],
                  ['outputTokens', '输出 Token'],
                  ['cacheReadTokens', '缓存读取 Token'],
                  ['cacheWriteTokens', '缓存写入 Token'],
                  ['webSearchCalls', 'Web Search 调用次数'],
                  ['webSearchPreviewCalls', 'Web Search Preview 调用次数'],
                ] as const
              ).map(([key, label]) => (
                <FormInput
                  key={key}
                  label={label}
                  inputMode="numeric"
                  value={counts[key]}
                  onChange={(e) => setCounts({ ...counts, [key]: e.target.value })}
                  required
                />
              ))}
            </Grid>
            <SelectField
              label="渠道（可选）"
              value={channelId}
              onChange={setChannelId}
              options={(catalog.data?.channels ?? [])
                .filter((c) => c.availableModels.some((m) => m.modelId === modelId))
                .map((c) => ({ id: c.id, name: c.name }))}
            />
            {!channelId && (
              <FormInput
                label="预览倍率"
                value={multiplier}
                inputMode="decimal"
                required
                onChange={(e) => setMultiplier(e.target.value)}
              />
            )}
            <ErrorText>{formError(task.error ?? catalog.error)?.message}</ErrorText>
            <PrimaryButton type="submit" alignSelf="start" loading={task.isPending}>
              计算费用
            </PrimaryButton>
          </Stack>
        </form>
        {task.data && (
          <Stack gap="3">
            <HStack gap="2" flexWrap="wrap">
              <Text fontWeight="600">
                {displayRange(task.data.total, task.data.maximum.total)} {task.data.currency}
              </Text>
              <Badge colorPalette="gray">未扣费</Badge>
            </HStack>
            <HStack gap="2" flexWrap="wrap">
              <Text fontSize="sm" overflowWrap="anywhere">
                {task.data.ruleLabel}
              </Text>
              <Badge colorPalette="gray">{kinds[task.data.ruleKind]}</Badge>
              <Badge colorPalette="gray">{displayMultiplier(task.data.multiplier, task.data.maximum.multiplier)}</Badge>
              <Badge colorPalette="gray">上下文 {task.data.contextTokens} Token</Badge>
            </HStack>
            {task.data.pricingMode === 'passthrough' && (
              <Text fontSize="sm" color="gray.500">
                透传倍率：此处按全部成员配置计算费用区间，实际扣费取决于路由成员。
              </Text>
            )}
            <Box overflowX="auto">
              <Table.Root size="sm" whiteSpace="nowrap">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>类别</Table.ColumnHeader>
                    <Table.ColumnHeader>用量</Table.ColumnHeader>
                    <Table.ColumnHeader>单价</Table.ColumnHeader>
                    <Table.ColumnHeader>金额</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {task.data.items.map((item) => (
                    <Table.Row key={item.category}>
                      <Table.Cell>
                        {
                          {
                            input: '普通输入',
                            output: '输出',
                            cacheRead: '缓存读',
                            cacheWrite: '缓存写',
                            webSearch: 'Web Search',
                            webSearchPreview: 'Web Search Preview',
                          }[item.category]
                        }
                      </Table.Cell>
                      <Table.Cell>
                        {item.tokens} {item.unit === 'thousand_calls' ? '次' : 'Token'}
                      </Table.Cell>
                      <Table.Cell>
                        {item.price ?? '—'} / {item.unit === 'thousand_calls' ? '千次' : '百万 Token'}
                      </Table.Cell>
                      <Table.Cell>
                        {displayRange(
                          item.amount,
                          task.data.maximum.items.find((entry) => entry.category === item.category)?.amount ??
                            item.amount,
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
            <Text color="gray.500" fontSize="xs">
              各项精确相加并应用倍率后，整次请求向上舍入到六位小数。
            </Text>
          </Stack>
        )}
      </Stack>
    </Panel>
  );
}
