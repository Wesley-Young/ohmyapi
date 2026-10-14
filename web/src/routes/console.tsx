import { Box, Flex, HStack, Link, Stack, Text } from '@chakra-ui/react';
import {
  CircleDollarSign,
  FlaskConical,
  KeyRound,
  Layers,
  LayoutDashboard,
  Network,
  ScrollText,
  Tags,
  UserRound,
  Users,
} from 'lucide-react';
import { NavLink, Outlet, Link as RouterLink, useMatch } from 'react-router';

import { Tooltip } from '../components/icon-button';
import { Logo } from '../components/logo';
import { ReviewBadge, ReviewDot, useReviewCount } from '../components/review-badge';
import { useAuth } from '../lib/auth';
import { brandColor, textColor } from '../lib/theme';

const navigationIcons = {
  overview: LayoutDashboard,
  keys: KeyRound,
  requests: ScrollText,
  users: Users,
  groups: Tags,
  channels: Network,
  models: Layers,
  plaza: CircleDollarSign,
  playground: FlaskConical,
};

function NavigationIcon({ name }: { name: keyof typeof navigationIcons }) {
  const Icon = navigationIcons[name];
  return <Icon size={20} strokeWidth={1.6} aria-hidden="true" focusable="false" style={{ flexShrink: 0 }} />;
}

export default function Console() {
  const auth = useAuth();
  const playground = Boolean(useMatch('/console/playground'));
  const reviews = useReviewCount(auth.data?.role === 'admin');
  if (!auth.data) return null;
  const links: { to: string; label: string; end: boolean; icon: keyof typeof navigationIcons; badge?: number }[] = [
    { to: '/console', label: '总览', end: true, icon: 'overview' },
    { to: '/console/model-plaza', label: '模型广场', end: false, icon: 'plaza' },
    { to: '/console/keys', label: 'API Key', end: false, icon: 'keys' },
    { to: '/console/playground', label: 'Playground', end: false, icon: 'playground' },
    { to: '/console/requests', label: '请求', end: false, icon: 'requests', badge: reviews },
    ...(auth.data.role === 'admin'
      ? [
          { to: '/console/channels', label: '渠道', end: false, icon: 'channels' as const },
          { to: '/console/models', label: '模型', end: false, icon: 'models' as const },
          { to: '/console/users', label: '用户', end: false, icon: 'users' as const },
          { to: '/console/groups', label: '用户组', end: false, icon: 'groups' as const },
        ]
      : []),
  ];
  return (
    <Flex key={auth.data.id} direction="column" minH="100dvh" h={playground ? '100dvh' : undefined}>
      <Box
        as="header"
        flexShrink="0"
        position="sticky"
        top="0"
        zIndex="10"
        bg="white"
        borderBottomWidth="1px"
        borderColor="gray.200"
      >
        <Flex h="64px" px={{ base: 4, md: 6 }} justify="space-between" align="center" gap="4">
          <Link asChild fontSize="24px" textDecoration="none">
            <RouterLink to="/">
              <Logo />
            </RouterLink>
          </Link>
          <HStack gap={{ base: 2, md: 4 }} minW="0">
            <Link asChild fontSize="sm" fontWeight="500" textDecoration="none" _hover={{ color: brandColor }}>
              <RouterLink to="/console/profile">
                <UserRound size={18} strokeWidth={1.6} aria-hidden="true" />
                {auth.data.username}
              </RouterLink>
            </Link>
          </HStack>
        </Flex>
      </Box>
      <Flex align={playground ? 'stretch' : 'start'} flex="1" minH={playground ? '0' : 'calc(100dvh - 64px)'}>
        <Box
          as="aside"
          w={{ base: '64px', md: '208px', lg: '228px' }}
          flexShrink="0"
          position="sticky"
          top="64px"
          h={playground ? 'full' : 'calc(100dvh - 64px)'}
          overflowY="auto"
          borderRightWidth="1px"
          borderColor="gray.200"
          bg="white"
          px={{ base: 2, md: 3 }}
          py="5"
        >
          <Stack as="nav" aria-label="控制台导航" gap="1">
            {links.map((link) => {
              const name = link.badge ? `${link.label}，${link.badge} 条待核对` : link.label;
              return (
                <Tooltip key={link.to} content={name}>
                  <NavLink
                    to={link.to}
                    end={link.end}
                    aria-label={name}
                    style={{ display: 'block', borderRadius: '8px' }}
                  >
                    {({ isActive }) => (
                      <HStack
                        gap="3"
                        h="44px"
                        px={{ base: 0, md: 3 }}
                        justify={{ base: 'center', md: 'start' }}
                        borderRadius="lg"
                        bg={isActive ? 'gray.100' : 'transparent'}
                        color={isActive ? textColor : 'gray.500'}
                        _hover={{ bg: isActive ? 'gray.100' : 'gray.50', color: textColor }}
                        fontSize="sm"
                        fontWeight={isActive ? '600' : '400'}
                      >
                        <Box position="relative" display="flex">
                          <NavigationIcon name={link.icon} />
                          <Box display={{ base: 'block', md: 'none' }}>
                            <ReviewDot count={link.badge ?? 0} />
                          </Box>
                        </Box>
                        <Text display={{ base: 'none', md: 'block' }} whiteSpace="nowrap" flex="1">
                          {link.label}
                        </Text>
                        <Box display={{ base: 'none', md: 'flex' }}>
                          <ReviewBadge count={link.badge ?? 0} />
                        </Box>
                      </HStack>
                    )}
                  </NavLink>
                </Tooltip>
              );
            })}
          </Stack>
        </Box>
        <Box
          flex="1"
          minW="0"
          minH="0"
          px={playground ? 0 : { base: 4, md: 8, lg: 10 }}
          py={playground ? 0 : { base: 7, md: 10 }}
        >
          <Stack
            gap="7"
            maxW={playground ? undefined : '1280px'}
            h={playground ? 'full' : undefined}
            minH="0"
            mx="auto"
          >
            <Outlet />
          </Stack>
        </Box>
      </Flex>
    </Flex>
  );
}
