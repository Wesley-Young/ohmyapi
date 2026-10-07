import { Badge, Box, Button, Checkbox, Grid, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ErrorText, FormDialog, FormInput, Loading, Panel, PrimaryButton } from '../components/ui';
import { formError } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';
import { SelectField } from './Catalog';

type Rule = Omit<RouterOutputs['admin']['pricing']['list']['rules'][number], 'id'>;
const kinds = { default: '默认', context: '上下文', time: '时段', combined: '上下文与时段' };
const defaultRule: Rule = {
  label: '默认价格',
  kind: 'default',
  contextMin: null,
  contextMax: null,
  weekdaysMask: null,
  startMinute: null,
  endMinute: null,
  inputPrice: '0',
  outputPrice: '0',
  cacheReadPrice: null,
  cacheWritePrice: null,
};
const minuteText = (minute: number | null) =>
  minute === null ? '' : `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const minuteValue = (value: string) => (value ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null);
const shanghaiNow = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16);
const isoShanghai = (value: string) => new Date(`${value}:00+08:00`).toISOString();
const dayNames = ['一', '二', '三', '四', '五', '六', '日'];
function RuleForm({
  initial,
  save,
  close,
  busy,
  error,
}: {
  initial: Rule;
  save: (r: Rule) => void;
  close: () => void;
  busy: boolean;
  error?: string;
}) {
  const [rule, setRule] = useState(initial);
  const [endText, setEndText] = useState(minuteText(initial.endMinute));
  const [localError, setLocalError] = useState<string>();
  const context = ['context', 'combined'].includes(rule.kind);
  const time = ['time', 'combined'].includes(rule.kind);
  const set = <K extends keyof Rule>(key: K, value: Rule[K]) => setRule((r) => ({ ...r, [key]: value }));
  return (
    <FormDialog open title="价格规则" onClose={close} busy={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (time && !/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(endText))
            return setLocalError('结束时间格式需为 HH:mm');
          setLocalError(undefined);
          save({
            ...rule,
            contextMin: context ? rule.contextMin : null,
            contextMax: context ? rule.contextMax : null,
            weekdaysMask: time ? rule.weekdaysMask : null,
            startMinute: time ? rule.startMinute : null,
            endMinute: time ? minuteValue(endText) : null,
          });
        }}
      >
        <Stack gap="5">
          <FormInput
            label="规则名称"
            value={rule.label}
            onChange={(e) => set('label', e.target.value)}
            required
            maxLength={64}
          />
          <SelectField
            label="条件类型"
            value={rule.kind}
            options={Object.entries(kinds).map(([id, name]) => ({ id, name }))}
            onChange={(v) => {
              if (!v) return;
              const kind = v as Rule['kind'];
              if (['time', 'combined'].includes(kind)) setEndText(minuteText(rule.endMinute ?? 1440));
              setRule((r) => ({
                ...r,
                kind,
                contextMin: ['context', 'combined'].includes(kind) ? (r.contextMin ?? '0') : null,
                contextMax: ['context', 'combined'].includes(kind) ? r.contextMax : null,
                weekdaysMask: ['time', 'combined'].includes(kind) ? (r.weekdaysMask ?? 127) : null,
                startMinute: ['time', 'combined'].includes(kind) ? (r.startMinute ?? 0) : null,
                endMinute: ['time', 'combined'].includes(kind) ? (r.endMinute ?? 1440) : null,
              }));
            }}
          />
          {context && (
            <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap="4">
              <FormInput
                label="最小上下文 Token（含）"
                inputMode="numeric"
                value={rule.contextMin ?? ''}
                required
                onChange={(e) => set('contextMin', e.target.value)}
              />
              <FormInput
                label="最大上下文 Token（不含）"
                inputMode="numeric"
                value={rule.contextMax ?? ''}
                placeholder="无上限"
                onChange={(e) => set('contextMax', e.target.value || null)}
              />
            </Grid>
          )}
          {time && (
            <>
              <Box as="fieldset">
                <Text as="legend" fontSize="sm" fontWeight="500" mb="2">
                  星期
                </Text>
                <HStack flexWrap="wrap">
                  {dayNames.map((d, i) => (
                    <Checkbox.Root
                      key={d}
                      checked={Boolean((rule.weekdaysMask ?? 0) & (1 << i))}
                      onCheckedChange={(e) =>
                        set(
                          'weekdaysMask',
                          e.checked ? (rule.weekdaysMask ?? 0) | (1 << i) : (rule.weekdaysMask ?? 0) & ~(1 << i),
                        )
                      }
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                      <Checkbox.Label>周{d}</Checkbox.Label>
                    </Checkbox.Root>
                  ))}
                </HStack>
              </Box>
              <Grid templateColumns="1fr 1fr" gap="4">
                <FormInput
                  label="开始时间"
                  type="time"
                  required
                  value={minuteText(rule.startMinute)}
                  onChange={(e) => set('startMinute', minuteValue(e.target.value))}
                />
                <FormInput
                  label="结束时间"
                  value={endText}
                  onChange={(e) => {
                    setEndText(e.target.value);
                    setLocalError(undefined);
                  }}
                  required
                  placeholder="24:00"
                  helper="HH:mm，允许 24:00；早于开始时间表示跨午夜"
                />
              </Grid>
              <Text fontSize="xs" color="gray.500">
                Asia/Shanghai；跨午夜按所选星期的开始日计算。
              </Text>
            </>
          )}
          <Text fontSize="sm" color="gray.500">
            单价按每百万 Token，最多六位小数。缓存价格留空表示尚未支持，填写 0 表示免费。
          </Text>
          <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap="4">
            {(
              [
                ['inputPrice', '普通输入单价'],
                ['outputPrice', '输出单价'],
                ['cacheReadPrice', '缓存读取单价'],
                ['cacheWritePrice', '缓存写入单价'],
              ] as const
            ).map(([key, label]) => (
              <FormInput
                key={key}
                label={label}
                inputMode="decimal"
                required={key === 'inputPrice' || key === 'outputPrice'}
                value={rule[key] ?? ''}
                onChange={(e) =>
                  set(key, e.target.value || (key === 'inputPrice' || key === 'outputPrice' ? '' : null))
                }
              />
            ))}
          </Grid>
          <ErrorText>{localError ?? error}</ErrorText>
          <HStack>
            <PrimaryButton type="submit" loading={busy}>
              保存规则
            </PrimaryButton>
            <Button variant="ghost" disabled={busy} onClick={close}>
              取消
            </Button>
          </HStack>
        </Stack>
      </form>
    </FormDialog>
  );
}
function Preview({ modelId }: { modelId: string }) {
  const [at, setAt] = useState(shanghaiNow);
  const [counts, setCounts] = useState({
    inputTokens: '0',
    outputTokens: '0',
    cacheReadTokens: '0',
    cacheWriteTokens: '0',
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
                {task.data.total} {task.data.currency}
              </Text>
              <Badge colorPalette="gray">未扣费</Badge>
            </HStack>
            <HStack gap="2" flexWrap="wrap">
              <Text fontSize="sm" overflowWrap="anywhere">
                {task.data.ruleLabel}
              </Text>
              <Badge colorPalette="gray">{kinds[task.data.ruleKind]}</Badge>
              <Badge colorPalette="gray">{Number(task.data.multiplier)}×</Badge>
              <Badge colorPalette="gray">上下文 {task.data.contextTokens} Token</Badge>
            </HStack>
            <Box overflowX="auto">
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>类别</Table.ColumnHeader>
                    <Table.ColumnHeader>Token</Table.ColumnHeader>
                    <Table.ColumnHeader>单价 / 百万</Table.ColumnHeader>
                    <Table.ColumnHeader>金额</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {task.data.items.map((item) => (
                    <Table.Row key={item.category}>
                      <Table.Cell>
                        {
                          { input: '普通输入', output: '输出', cacheRead: '缓存读', cacheWrite: '缓存写' }[
                            item.category
                          ]
                        }
                      </Table.Cell>
                      <Table.Cell>{item.tokens}</Table.Cell>
                      <Table.Cell>{item.price ?? '—'}</Table.Cell>
                      <Table.Cell title={item.amount}>{item.amount.replace(/0+$/, '').replace(/\.$/, '')}</Table.Cell>
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
export default function Pricing({ modelId }: { modelId: string }) {
  const scope = { modelId };
  const data = useQuery(trpc.admin.pricing.list.queryOptions(scope));
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
      <ErrorText>{formError(data.error)?.message}</ErrorText>
      {data.isPending ? (
        <Loading />
      ) : data.data ? (
        <>
          <ErrorText>{formError(save.error)?.message}</ErrorText>
          <Box overflowX="auto">
            <Table.Root size="sm">
              <Table.Header>
                <Table.Row>
                  {['规则名称', '条件', '输入', '输出', '缓存读', '缓存写', '操作'].map((h) => (
                    <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                  ))}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.data.rules.map((r, index) => (
                  <Table.Row key={r.id}>
                    <Table.Cell>{r.label}</Table.Cell>
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
                    <Table.Cell>
                      <HStack>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={save.isPending}
                          onClick={() => {
                            save.reset();
                            setEditingRule({ index, rule: currentRules[index] });
                          }}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={save.isPending || (r.kind === 'default' && currentRules.length > 1)}
                          onClick={() => save.mutate({ modelId, rules: currentRules.filter((_, i) => i !== index) })}
                        >
                          删除
                        </Button>
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
          {currentRules.length > 0 && <Preview key={data.data.rules.map((r) => r.id).join(':')} modelId={modelId} />}
        </>
      ) : null}
    </Stack>
  );
}
