import { Flex, Heading, Stack } from '@chakra-ui/react';
import { useNavigate } from 'react-router';

import { Logo } from '../components/logo';
import { PrimaryButton } from '../components/ui';

export default function Landing() {
  const navigate = useNavigate();
  return (
    <Flex minH="100dvh" align="center" justify="center" px="6">
      <Stack align="center" gap="8">
        <Heading as="h1" fontSize={{ base: '48px', md: '64px' }} lineHeight="1">
          <Logo />
        </Heading>
        <PrimaryButton type="button" onClick={() => navigate('/login')} size="md" px="8">
          登录
        </PrimaryButton>
      </Stack>
    </Flex>
  );
}
