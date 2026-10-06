import { Container, Heading, Link, Stack, Text } from '@chakra-ui/react';
import { Link as RouterLink } from 'react-router';

export default function NotFound() {
  return (
    <Container maxW="1200px" px={{ base: 6, md: 10 }} py="20">
      <Stack gap="5" align="start">
        <Text fontSize="sm" color="#635bff" fontWeight="600">
          404
        </Text>
        <Heading as="h1" size="2xl">
          这个页面还不存在。
        </Heading>
        <Link asChild color="#635bff" fontWeight="600">
          <RouterLink to="/">返回首页 →</RouterLink>
        </Link>
      </Stack>
    </Container>
  );
}
