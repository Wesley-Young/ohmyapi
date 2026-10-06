import { Button, Heading, Stack } from '@chakra-ui/react';

export default function Landing() {
  return (
    <Stack align="center" gap="8">
      <Heading as="h1" fontSize={{ base: '48px', md: '64px' }} fontWeight="800" letterSpacing="-0.07em" lineHeight="1">
        ohmyapi
      </Heading>
      <Button
        type="button"
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
  );
}
