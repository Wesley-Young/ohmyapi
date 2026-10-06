import { Box, Button, Container, Flex, HStack, Link, Stack, Text } from '@chakra-ui/react';
import { useMutation } from '@tanstack/react-query';
import { Navigate, NavLink, Outlet, Link as RouterLink } from 'react-router';

import { ErrorText } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formError } from '../lib/format';
import { setSession, trpc } from '../lib/trpc';

export default function Console() {
  const auth = useAuth();
  const task = useMutation(trpc.auth.logout.mutationOptions({ onSuccess: () => setSession(null) }));
  if (!auth.data) return null;
  const links = [
    { to: '/console', label: '余额', end: true },
    { to: '/console/keys', label: 'API Key', end: false },
    { to: '/console/requests', label: '请求', end: false },
    ...(auth.data.role === 'admin'
      ? [
          { to: '/console/users', label: '用户', end: false },
          { to: '/console/channels', label: '渠道', end: false },
          { to: '/console/models', label: '模型', end: false },
        ]
      : []),
  ];
  return (
    <Box key={auth.data.id}>
      <Box as="header" borderBottomWidth="1px" borderColor="gray.200">
        <Container maxW="1100px" px={{ base: 5, md: 8 }}>
          <Flex py="5" justify="space-between" align="center" gap="4" flexWrap="wrap">
            <Link asChild fontSize="xl" fontWeight="800" letterSpacing="-0.06em" textDecoration="none">
              <RouterLink to="/">ohmyapi</RouterLink>
            </Link>
            <HStack gap="4" flexWrap="wrap">
              <Text
                fontSize="sm"
                color="gray.500"
                truncate
                maxW={{ base: '140px', md: '240px' }}
                title={auth.data.username}
              >
                {auth.data.username}
              </Text>
              <Link asChild fontSize="sm">
                <RouterLink to="/change-password">修改密码</RouterLink>
              </Link>
              <Button size="sm" variant="ghost" loading={task.isPending} onClick={() => task.mutate()}>
                退出
              </Button>
            </HStack>
          </Flex>
          <HStack as="nav" aria-label="控制台导航" gap="6" overflowX="auto">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                style={({ isActive }) => ({
                  color: isActive ? '#171717' : '#737373',
                  borderBottom: `2px solid ${isActive ? '#635bff' : 'transparent'}`,
                  padding: '0 0 14px',
                  fontSize: '14px',
                  whiteSpace: 'nowrap',
                  fontWeight: isActive ? 600 : 400,
                })}
              >
                {link.label}
              </NavLink>
            ))}
          </HStack>
        </Container>
      </Box>
      <Container maxW="1100px" px={{ base: 5, md: 8 }} py={{ base: 7, md: 10 }}>
        <Stack gap="7">
          <ErrorText>{formError(task.error)?.message}</ErrorText>
          <Outlet />
        </Stack>
      </Container>
    </Box>
  );
}

export function AdminOnly() {
  const { data: user } = useAuth();
  return user?.role === 'admin' ? <Outlet /> : <Navigate to="/console" replace />;
}
