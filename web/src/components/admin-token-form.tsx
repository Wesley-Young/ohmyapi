import { Box, Button, Checkbox, Fieldset, HStack, Stack, Text } from '@chakra-ui/react';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { type AdminScope, adminScopeLabels, adminScopes } from '../lib/admin-scopes';
import { formError } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';
import { IconButton } from './icon-button';
import { ErrorText, FormDialog, FormInput, PrimaryButton } from './ui';

/** 创建管理令牌；创建成功后只展示一次令牌明文。 */
export function AdminTokenForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<AdminScope[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [localError, setLocalError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const task = useMutation(
    trpc.admin.tokens.create.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.admin.tokens.list.queryFilter()),
    }),
  );
  const token = task.data?.token;

  return (
    <FormDialog open title={token ? '令牌已创建' : '创建管理令牌'} busy={task.isPending} onClose={onClose}>
      {token ? (
        <Stack gap="5">
          <Text color="gray.600">令牌只显示这一次，请复制后妥善保存。</Text>
          <HStack gap="2" align="start" borderWidth="1px" borderColor="gray.200" borderRadius="lg" px="3" py="2">
            <Box as="code" flex="1" minW="0" fontFamily="mono" fontSize="sm" overflowWrap="anywhere" py="1">
              {token}
            </Box>
            <IconButton
              variant="ghost"
              size="xs"
              aria-label={copied ? '已复制令牌' : '复制令牌'}
              title={copied ? '已复制' : '复制'}
              onClick={async () => {
                setLocalError(undefined);
                try {
                  await navigator.clipboard.writeText(token);
                  setCopied(true);
                } catch {
                  setLocalError('复制失败，请检查浏览器剪贴板权限，或手动选中复制');
                }
              }}
            >
              {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            </IconButton>
          </HStack>
          <ErrorText>{localError}</ErrorText>
          <HStack>
            <PrimaryButton onClick={onClose}>完成</PrimaryButton>
          </HStack>
        </Stack>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setLocalError(undefined);
            if (task.isPending) return;
            if (!scopes.length) return setLocalError('至少选择一项权限');
            const expiration = expiresAt ? new Date(expiresAt) : undefined;
            if (expiration && !Number.isFinite(expiration.getTime())) return setLocalError('请输入有效的日期和时间');
            if (expiration && expiration.getTime() <= Date.now()) return setLocalError('有效期必须晚于当前时间');
            task.mutate({
              name,
              scopes: adminScopes.filter((scope) => scopes.includes(scope)),
              expiresAt: expiration?.toISOString(),
            });
          }}
        >
          <Stack gap="5">
            <FormInput label="名称" value={name} required maxLength={64} onChange={(e) => setName(e.target.value)} />
            <Fieldset.Root>
              <Fieldset.Legend fontSize="sm" fontWeight="500">
                权限
              </Fieldset.Legend>
              <Stack gap="2" mt="2">
                {adminScopes.map((scope) => (
                  <Checkbox.Root
                    key={scope}
                    checked={scopes.includes(scope)}
                    onCheckedChange={(e) =>
                      setScopes(e.checked ? [...scopes, scope] : scopes.filter((item) => item !== scope))
                    }
                  >
                    <Checkbox.HiddenInput />
                    <Checkbox.Control />
                    <Checkbox.Label>
                      {adminScopeLabels[scope]}
                      <Text as="span" ms="2" fontFamily="mono" fontSize="xs" color="gray.500">
                        {scope}
                      </Text>
                    </Checkbox.Label>
                  </Checkbox.Root>
                ))}
              </Stack>
            </Fieldset.Root>
            <FormInput
              label="有效期"
              type="datetime-local"
              step="any"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              helper="留空表示长期有效"
            />
            <ErrorText>{localError ?? formError(task.error)?.message}</ErrorText>
            <HStack>
              <PrimaryButton type="submit" loading={task.isPending}>
                创建
              </PrimaryButton>
              <Button variant="ghost" disabled={task.isPending} onClick={onClose}>
                取消
              </Button>
            </HStack>
          </Stack>
        </form>
      )}
    </FormDialog>
  );
}
