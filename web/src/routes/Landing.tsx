import { Button, Flex, Heading, Stack } from '@chakra-ui/react';
import { useNavigate } from 'react-router';

import { Logo } from '../components/logo';

export default function Landing() {
  const navigate = useNavigate();
  return (
    <Flex minH="100dvh" align="center" justify="center" px="6">
      <Stack align="center" gap="8">
        <Heading as="h1" fontSize={{ base: '48px', md: '64px' }} lineHeight="1">
          <Logo />
        </Heading>
        <Button
          type="button"
          onClick={() => navigate('/login')}
          size="md"
          px="8"
          borderRadius="full"
          bg="#635bff"
          color="white"
          fontWeight="600"
          _hover={{ bg: '#5146e6' }}
        >
          登录
        </Button>
      </Stack>
    </Flex>
  );
}
