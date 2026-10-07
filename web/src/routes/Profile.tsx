import { Badge, Box, Button, Heading, HStack, Stack, Text } from '@chakra-ui/react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { ErrorText, Panel, Title } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formError } from '../lib/format';
import { setSession, trpc } from '../lib/trpc';
import ChangePassword from './ChangePassword';

export default function Profile() {
  const { data: user } = useAuth();
  const [changingPassword, setChangingPassword] = useState(false);
  const logout = useMutation(trpc.auth.logout.mutationOptions({ onSuccess: () => setSession(null) }));
  if (!user) return null;

  return (
    <Stack gap="7" w="full" maxW="640px">
      <Title>个人信息</Title>
      <Panel>
        <Stack gap="6">
          <Stack gap="2">
            <Text fontSize="sm" color="gray.500">
              用户名
            </Text>
            <Text fontWeight="500" overflowWrap="anywhere">
              {user.username}
            </Text>
          </Stack>
          <Stack gap="2" align="start">
            <Text fontSize="sm" color="gray.500">
              账号角色
            </Text>
            <Badge>{user.role === 'admin' ? '管理员' : '用户'}</Badge>
          </Stack>
          <Box borderTopWidth="1px" borderColor="gray.200" pt="6">
            <HStack justify="space-between" gap="4" flexWrap="wrap">
              <Heading as="h2" fontSize="sm" fontWeight="500">
                密码
              </Heading>
              <Button variant="outline" size="sm" borderRadius="full" onClick={() => setChangingPassword(true)}>
                修改密码
              </Button>
            </HStack>
          </Box>
        </Stack>
      </Panel>
      <Stack gap="3" align="start">
        <ErrorText>{formError(logout.error)?.message}</ErrorText>
        <Button
          variant="outline"
          size="sm"
          borderRadius="full"
          loading={logout.isPending}
          onClick={() => logout.mutate()}
        >
          退出登录
        </Button>
      </Stack>
      {changingPassword && <ChangePassword onClose={() => setChangingPassword(false)} />}
    </Stack>
  );
}
