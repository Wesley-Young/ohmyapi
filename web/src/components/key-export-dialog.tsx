import { Button, Stack } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { type AccessEndpoint, accessEndpointOptions } from '../lib/access-endpoints';
import { formError } from '../lib/format';
import { trpc } from '../lib/trpc';
import { ErrorText, FormDialog, Loading } from './ui';

export type ExportKey = RouterOutputs['keys']['playgroundOptions'][number];

export const keyExpired = (key: ExportKey) => key.expiresAt !== null && new Date(key.expiresAt).getTime() <= Date.now();

/** 导出 Key 的弹窗：读取 Key 的最新可用端点和模型，可以导出时显示 children 中的表单。 */
export function KeyExportDialog({
  keyId,
  title,
  unsupported,
  onClose,
  children,
}: {
  keyId: string;
  title: string;
  /** 此 Key 不能导出到目标时的原因。 */
  unsupported: (key: ExportKey) => string | undefined;
  onClose: () => void;
  children: (props: { apiKey: ExportKey; accessEndpoints: AccessEndpoint[]; refreshing: boolean }) => ReactNode;
}) {
  const options = useQuery(trpc.keys.playgroundOptions.queryOptions(undefined, { staleTime: 0, gcTime: 0 }));
  const accessEndpoints = useQuery(trpc.keys.accessEndpoints.queryOptions());
  const selectedKey = options.data?.find((key) => key.id === keyId);
  const error = options.error ?? accessEndpoints.error;
  const reason = selectedKey && unsupported(selectedKey);
  return (
    <FormDialog open title={title} onClose={onClose}>
      {options.isPending || !options.isFetchedAfterMount || accessEndpoints.isPending ? (
        <Loading />
      ) : error ? (
        <Stack gap="4">
          <ErrorText>{formError(error)?.message}</ErrorText>
          <Button
            variant="outline"
            alignSelf="start"
            loading={options.isFetching || accessEndpoints.isFetching}
            onClick={() => {
              if (options.error) options.refetch();
              if (accessEndpoints.error) accessEndpoints.refetch();
            }}
          >
            重试
          </Button>
        </Stack>
      ) : !selectedKey ? (
        <ErrorText>此 Key 已失效，或渠道没有已授权且已定价的可用模型。</ErrorText>
      ) : reason ? (
        <ErrorText>{reason}</ErrorText>
      ) : (
        children({
          apiKey: selectedKey,
          accessEndpoints: accessEndpointOptions(accessEndpoints.data),
          refreshing: options.isFetching,
        })
      )}
    </FormDialog>
  );
}
