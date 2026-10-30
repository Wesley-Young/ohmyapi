import { Badge, Box, Button, HStack, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation } from '@tanstack/react-query';
import { Eye } from 'lucide-react';

import { refreshModeration } from '../lib/cache';
import { formError, localDateTime } from '../lib/format';
import {
  categoryLabels,
  reasonLabels,
  severityLabels,
  statusLabels,
  verdictColors,
  verdictLabels,
} from '../lib/moderation';
import { trpc } from '../lib/trpc';
import { ErrorText, Facts, FormDialog, PrimaryButton, Section } from './ui';

type Item = RouterOutputs['admin']['moderation']['list']['items'][number];

export function VerdictBadge({ item }: { item: Item }) {
  if (!item.verdict)
    return <Badge colorPalette={item.status === 'failed' ? 'red' : 'gray'}>{statusLabels[item.status]}</Badge>;
  return <Badge colorPalette={verdictColors[item.verdict]}>{verdictLabels[item.verdict]}</Badge>;
}

function TextBlock({ label, text }: { label: string; text: string }) {
  return (
    <Stack gap="1.5">
      <Text fontSize="xs" fontWeight="600" color="gray.500">
        {label}
      </Text>
      <Box
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="lg"
        px="3"
        py="2"
        maxH="320px"
        overflowY="auto"
        fontSize="sm"
        whiteSpace="pre-wrap"
        overflowWrap="anywhere"
      >
        {text}
      </Box>
    </Stack>
  );
}

/** 审计详情：判定结果和送审内容；内容按需解密，每次查看都记录审计日志。 */
export function ModerationDetail({ item, onClose }: { item: Item; onClose: () => void }) {
  const content = useMutation(trpc.admin.moderation.content.mutationOptions());
  const acknowledge = useMutation(
    trpc.admin.moderation.acknowledge.mutationOptions({
      onSuccess: async () => {
        await refreshModeration();
        onClose();
      },
    }),
  );
  const alert = (item.verdict === 'suspect' || item.verdict === 'violation') && !item.acknowledgedAt;
  const busy = content.isPending || acknowledge.isPending;
  const data = content.data;
  return (
    <FormDialog open title="审计详情" busy={busy} onClose={onClose} size="xl">
      <Stack gap="6">
        <Facts
          items={[
            { label: '判定', value: <VerdictBadge item={item} /> },
            ...(item.category ? [{ label: '类别', value: <Badge>{categoryLabels[item.category]}</Badge> }] : []),
            ...(item.severity !== null ? [{ label: '严重程度', value: severityLabels[item.severity] }] : []),
            ...(item.violationScore !== null
              ? [{ label: '违规概率', value: `${Math.round(item.violationScore * 100)}%` }]
              : []),
            { label: '用户', value: item.user.username },
            {
              label: '渠道',
              value: item.executionChannel ? `${item.entryChannel} → ${item.executionChannel}` : item.entryChannel,
            },
            { label: '模型', value: item.requestedModel },
            { label: '请求数', value: item.requestCount },
            { label: '抽样方式', value: reasonLabels[item.reason] },
            { label: '时间', value: `${localDateTime(item.firstSeenAt)} – ${localDateTime(item.lastSeenAt)}` },
            ...(item.acknowledgedAt ? [{ label: '确认时间', value: localDateTime(item.acknowledgedAt) }] : []),
          ]}
        />
        {item.lastError && <ErrorText>{item.lastError}</ErrorText>}
        <Section
          title="送审内容"
          hint={
            item.contentAvailable
              ? [
                  item.truncated && '内容较长，只保留了最近的部分',
                  item.imageCount > 0 && `另有 ${item.imageCount} 张图片未送审`,
                ]
                  .filter(Boolean)
                  .join('；') || undefined
              : '内容已超过保留期并清除。'
          }
          action={
            item.contentAvailable &&
            !data && (
              <Button
                size="sm"
                variant="outline"
                loading={content.isPending}
                disabled={busy}
                onClick={() => content.mutate({ id: item.id })}
              >
                <Eye size={16} aria-hidden="true" />
                查看内容
              </Button>
            )
          }
        >
          <ErrorText>{formError(content.error)?.message}</ErrorText>
          {data && (
            <Stack gap="4">
              {data.content.system && <TextBlock label="系统提示" text={data.content.system} />}
              {data.content.turns.map((turn, index) => (
                <TextBlock
                  // 快照只读，顺序固定。
                  // biome-ignore lint/suspicious/noArrayIndexKey: 对话轮次没有其他稳定标识
                  key={index}
                  label={turn.role === 'user' ? '用户' : '模型'}
                  text={turn.text}
                />
              ))}
            </Stack>
          )}
        </Section>
        <ErrorText>{formError(acknowledge.error)?.message}</ErrorText>
        {alert && (
          <HStack>
            <PrimaryButton
              loading={acknowledge.isPending}
              disabled={busy}
              onClick={() => acknowledge.mutate({ ids: [item.id] })}
            >
              确认预警
            </PrimaryButton>
          </HStack>
        )}
      </Stack>
    </FormDialog>
  );
}
