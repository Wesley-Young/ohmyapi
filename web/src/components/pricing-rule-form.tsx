import { Box, Button, Checkbox, Grid, HStack, Stack, Text } from '@chakra-ui/react';
import { useState } from 'react';

import { dayNames, kinds, minuteText, minuteValue, type Rule, type SearchDefaults } from '../lib/pricing';
import { SelectField } from './fields';
import { ErrorText, FormDialog, FormInput, PrimaryButton } from './ui';

export function RuleForm({
  initial,
  searchDefaults,
  save,
  close,
  busy,
  error,
}: {
  initial: Rule;
  searchDefaults: SearchDefaults;
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
            Token
            单价按每百万，搜索单价按每千次调用，最多六位小数。缓存价格留空表示未配置，搜索价格留空使用模型默认值，填写 0
            表示免费。
          </Text>
          <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap="4">
            {(
              [
                ['inputPrice', '普通输入单价'],
                ['outputPrice', '输出单价'],
                ['cacheReadPrice', '缓存读取单价'],
                ['cacheWritePrice', '缓存写入单价'],
                ['webSearchPrice', 'Web Search / 千次'],
                ['webSearchPreviewPrice', 'Web Search Preview / 千次'],
              ] as const
            ).map(([key, label]) => (
              <FormInput
                key={key}
                label={label}
                inputMode="decimal"
                required={key === 'inputPrice' || key === 'outputPrice'}
                value={rule[key] ?? ''}
                placeholder={
                  key === 'webSearchPrice' || key === 'webSearchPreviewPrice'
                    ? (searchDefaults[key] ?? undefined)
                    : undefined
                }
                helper={
                  key === 'webSearchPrice' || key === 'webSearchPreviewPrice'
                    ? searchDefaults[key] === null
                      ? '该模型无默认搜索价格'
                      : `默认 ${searchDefaults[key]} / 千次`
                    : undefined
                }
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
