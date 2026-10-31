import { Box, Grid, HStack, Stack, Table, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { displayMoney, displayMultiplier, displayRange, formatCount, formError } from '../lib/format';
import { kinds } from '../lib/pricing';
import { trpc } from '../lib/trpc';
import { SelectField } from './fields';
import { ErrorText, FormDialog, FormInput, PrimaryButton } from './ui';

/** 预览时间按上海时间（UTC+8）输入和换算。 */
const shanghaiNow = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16);
const isoShanghai = (value: string) => new Date(`${value}:00+08:00`).toISOString();

const categories = {
  input: '输入',
  output: '输出',
  cacheRead: '缓存读',
  cacheWrite: '缓存写',
  webSearch: 'Web Search',
  webSearchPreview: 'Web Search Preview',
};

/** 按当前定价规则试算一次请求的费用，不扣费；没有搜索价格时不显示搜索次数。 */
export function PricingPreview({
  modelId,
  showSearch,
  close,
}: {
  modelId: string;
  showSearch: boolean;
  close: () => void;
}) {
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
  const fields = [
    ['inputTokens', '输入 Token'],
    ['outputTokens', '输出 Token'],
    ['cacheReadTokens', '缓存读 Token'],
    ['cacheWriteTokens', '缓存写 Token'],
    ...(showSearch
      ? ([
          ['webSearchCalls', 'Web Search 次数'],
          ['webSearchPreviewCalls', 'Web Search Preview 次数'],
        ] as const)
      : []),
  ] as const;
  const result = task.data;
  return (
    <FormDialog open title="费用试算" onClose={close}>
      <Stack gap="5">
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
                ...(showSearch ? {} : { webSearchCalls: '0', webSearchPreviewCalls: '0' }),
                channelId: channelId || undefined,
                multiplier: channelId ? undefined : multiplier,
              });
          }}
        >
          <Stack gap="4">
            <Grid templateColumns={{ base: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' }} gap="3">
              {fields.map(([key, label]) => (
                <Box key={key} gridColumn={key.startsWith('webSearch') ? 'span 2' : undefined}>
                  <FormInput
                    label={label}
                    inputMode="numeric"
                    value={counts[key]}
                    onChange={(e) => setCounts({ ...counts, [key]: e.target.value })}
                    required
                  />
                </Box>
              ))}
            </Grid>
            <Grid
              templateColumns={{ base: 'minmax(0, 1fr)', sm: channelId ? '1fr 1fr' : '2fr 1fr 2fr' }}
              gap="3"
              alignItems="end"
            >
              <SelectField
                label="渠道"
                value={channelId}
                onChange={setChannelId}
                options={(catalog.data?.channels ?? [])
                  .filter((c) => c.availableModels.some((m) => m.modelId === modelId))
                  .map((c) => ({ id: c.id, name: c.name }))}
              />
              {!channelId && (
                <FormInput
                  label="倍率"
                  value={multiplier}
                  inputMode="decimal"
                  required
                  onChange={(e) => setMultiplier(e.target.value)}
                />
              )}
              <FormInput
                label="请求时间（上海）"
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
                required
              />
            </Grid>
            <ErrorText>{formError(task.error ?? catalog.error)?.message}</ErrorText>
            <PrimaryButton type="submit" alignSelf="start" loading={task.isPending}>
              计算费用
            </PrimaryButton>
          </Stack>
        </form>
        {result && (
          <Stack gap="3" borderTopWidth="1px" borderColor="gray.200" pt="4" role="status">
            <HStack justify="space-between" align="baseline" gap="4" flexWrap="wrap">
              <Text fontSize="sm" color="gray.500">
                预计费用（不扣费）
              </Text>
              <Text fontSize="xl" fontWeight="600" fontVariantNumeric="tabular-nums">
                {displayRange(result.total, result.maximum.total)} {result.currency}
              </Text>
            </HStack>
            <Text fontSize="sm" color="gray.600" overflowWrap="anywhere">
              命中「{result.ruleLabel}」（{kinds[result.ruleKind]}），倍率{' '}
              {displayMultiplier(result.multiplier, result.maximum.multiplier)}，上下文{' '}
              {formatCount(result.contextTokens)} Token
            </Text>
            {result.pricingMode === 'passthrough' && (
              <Text fontSize="xs" color="gray.500">
                透传倍率按全部成员配置计算费用区间，实际扣费取决于路由成员。
              </Text>
            )}
            <Box overflowX="auto">
              <Table.Root size="sm" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
                <Table.Body>
                  {result.items.map((item) => {
                    const calls = item.unit === 'thousand_calls';
                    return (
                      <Table.Row key={item.category}>
                        <Table.Cell>{categories[item.category]}</Table.Cell>
                        <Table.Cell textAlign="end" color="gray.600">
                          {formatCount(item.tokens)} {calls ? '次' : 'Token'} ×{' '}
                          {item.price ? displayMoney(item.price) : '—'} / {calls ? '千次' : '百万'}
                        </Table.Cell>
                        <Table.Cell textAlign="end">
                          {displayRange(
                            item.amount,
                            result.maximum.items.find((entry) => entry.category === item.category)?.amount ??
                              item.amount,
                          )}
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
            </Box>
            <Text color="gray.500" fontSize="xs">
              各项精确相加并应用倍率后，整次请求向上舍入到六位小数。
            </Text>
          </Stack>
        )}
      </Stack>
    </FormDialog>
  );
}
