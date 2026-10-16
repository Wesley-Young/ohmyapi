import { Badge, Box, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';

import { adminScopeLabels, adminScopes } from '../lib/admin-scopes';
import { formError, localDate } from '../lib/format';
import { queryClient, trpc, trpcClient } from '../lib/trpc';
import { AdminTokenForm } from './admin-token-form';
import { ConfirmAction, ErrorText, Loading, PrimaryButton, pinnedColumn } from './ui';

/** 当前管理员的公开 API 管理令牌。 */
export function AdminTokens() {
  const [creating, setCreating] = useState(false);
  const tokens = useQuery(trpc.admin.tokens.list.queryOptions());
  return (
    <Stack gap="4">
      <HStack justify="space-between" gap="4" flexWrap="wrap">
        <Heading as="h2" fontSize="lg">
          管理令牌
        </Heading>
        <PrimaryButton size="sm" onClick={() => setCreating(true)}>
          创建令牌
        </PrimaryButton>
      </HStack>
      <ErrorText>{formError(tokens.error)?.message}</ErrorText>
      {creating && <AdminTokenForm onClose={() => setCreating(false)} />}
      {tokens.isPending ? (
        <Loading />
      ) : tokens.data?.length ? (
        <Box overflowX="auto">
          <Table.Root size="sm" whiteSpace="nowrap">
            <Table.Header>
              <Table.Row>
                {['名称', '权限', '有效期', '最近使用'].map((h) => (
                  <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                ))}
                <Table.ColumnHeader {...pinnedColumn}>操作</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {tokens.data.map((token) => {
                const expired = token.expiresAt !== null && new Date(token.expiresAt).getTime() <= Date.now();
                return (
                  <Table.Row key={token.id}>
                    <Table.Cell>
                      <Stack gap="0.5">
                        <Text>{token.name}</Text>
                        <Text fontFamily="mono" fontSize="xs" color="gray.500">
                          oma_admin_…{token.hint}
                        </Text>
                      </Stack>
                    </Table.Cell>
                    <Table.Cell>
                      <HStack gap="1.5">
                        {adminScopes
                          .filter((scope) => token.scopes.includes(scope))
                          .map((scope) => (
                            <Badge key={scope} title={scope}>
                              {adminScopeLabels[scope]}
                            </Badge>
                          ))}
                      </HStack>
                    </Table.Cell>
                    <Table.Cell>
                      <HStack gap="2">
                        <Text>{token.expiresAt ? localDate(token.expiresAt) : '长期'}</Text>
                        {expired && <Badge colorPalette="red">已过期</Badge>}
                      </HStack>
                    </Table.Cell>
                    <Table.Cell>{token.lastUsedAt ? localDate(token.lastUsedAt) : '从未使用'}</Table.Cell>
                    <Table.Cell {...pinnedColumn}>
                      <ConfirmAction
                        label="吊销"
                        icon={<Trash2 size={16} aria-hidden="true" />}
                        danger
                        description={`吊销「${token.name}」后，使用它的程序将立即无法调用 API，且无法恢复。`}
                        action={() => trpcClient.admin.tokens.revoke.mutate({ tokenId: token.id })}
                        onSuccess={() => queryClient.invalidateQueries(trpc.admin.tokens.list.queryFilter())}
                      />
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        </Box>
      ) : (
        <Text color="gray.500" fontSize="sm">
          暂无令牌
        </Text>
      )}
    </Stack>
  );
}
