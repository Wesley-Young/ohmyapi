import { Button, Stack } from '@chakra-ui/react';
import { Navigate, Outlet } from 'react-router';

import { useAuth } from '../lib/auth';
import { formError } from '../lib/format';
import { Centered, ErrorText, Loading } from './ui';

/** 仅登录用户可访问；切换账号时重新挂载子路由。 */
export function Authenticated() {
  const auth = useAuth();
  if (auth.isPending)
    return (
      <Centered>
        <Loading />
      </Centered>
    );
  if (auth.error)
    return (
      <Centered>
        <Stack gap="4">
          <ErrorText>{formError(auth.error)?.message}</ErrorText>
          <Button onClick={() => auth.refetch()}>重新加载</Button>
        </Stack>
      </Centered>
    );
  return auth.data ? <Outlet key={auth.data.id} /> : <Navigate to="/login" replace />;
}

/** 仅管理员可访问，其他用户回到控制台首页。 */
export function AdminOnly() {
  const { data: user } = useAuth();
  return user?.role === 'admin' ? <Outlet /> : <Navigate to="/console" replace />;
}
